"""Retain the model group leader until its descendants have been terminated."""

import ctypes
import errno
import json
import os
import select
import signal
import subprocess
import sys
import time


def exited(pid: int) -> bool:
    """Observe exit without reaping: the leader PID still reserves the owned PGID."""
    options = os.WEXITED | os.WNOHANG | os.WNOWAIT
    while True:
        try:
            if hasattr(os, "waitid"):
                return os.waitid(os.P_PID, pid, options) is not None
            if sys.platform != "darwin":
                raise RuntimeError("non-reaping waitid is unavailable")
            # macOS Python omits os.waitid, although libc exposes the POSIX API.
            # siginfo_t fits in this zeroed, long-aligned 256-byte buffer.
            info = (ctypes.c_long * 32)()
            libc = ctypes.CDLL(None, use_errno=True)
            waitid = libc.waitid
            waitid.argtypes = [
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            waitid.restype = ctypes.c_int
            if waitid(os.P_PID, pid, ctypes.byref(info), options) != 0:
                number = ctypes.get_errno()
                raise OSError(number, os.strerror(number))
            return ctypes.cast(info, ctypes.POINTER(ctypes.c_int))[0] != 0
        except InterruptedError:
            continue
        except ChildProcessError as error:
            raise RuntimeError("model group ownership was lost") from error


def zombie_group(pid: int) -> bool:
    """Darwin killpg returns EPERM if every remaining group member is a zombie."""
    observer = subprocess.Popen(
        ["/bin/ps", "-axo", "pgid=,stat="],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    output = bytearray()
    deadline = time.monotonic() + 1
    try:
        assert observer.stdout is not None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(output) > 1024 * 1024:
                return False
            ready, _, _ = select.select([observer.stdout], [], [], remaining)
            if not ready:
                return False
            chunk = os.read(observer.stdout.fileno(), 4096)
            if not chunk:
                break
            output.extend(chunk)
        if observer.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            return False
        states = []
        for line in output.decode("ascii", errors="strict").splitlines():
            group, state = line.split()
            if int(group) == pid:
                states.append(state)
        return bool(states) and all(state.startswith("Z") for state in states)
    finally:
        if observer.returncode is None:
            observer.kill()
        observer.wait(timeout=1)


def controller_closed(timeout: float) -> bool:
    try:
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        return bool(ready and not os.read(0, 1))
    except OSError as error:
        # libuv may use a socketpair whose peer death resets instead of EOF.
        if error.errno in (errno.ECONNRESET, errno.EPIPE, errno.EBADF):
            return True
        raise


def acknowledge(code: int) -> None:
    # fd 3 is guard-only (Popen close_fds); model output cannot forge this ACK.
    payload = json.dumps({"version": 1, "model_stopped": True, "returncode": code})
    try:
        os.write(3, payload.encode())
    except (BrokenPipeError, OSError):
        pass


def main() -> int:
    request = json.loads(sys.stdin.buffer.readline())
    controller_group = request.get("controllerGroup")
    if controller_group is not None and not (
        isinstance(controller_group, int)
        and controller_group > 1
        and controller_group == os.getpgrp() == os.getppid()
    ):
        raise RuntimeError("worker group ownership does not match its parent")
    try:
        child = subprocess.Popen(
            request["argv"],
            cwd=request["cwd"],
            env=request["env"],
            stdin=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
    except Exception:
        acknowledge(1)  # No model was started.
        raise

    group_stopped = False

    def terminate() -> None:
        nonlocal group_stopped
        if group_stopped:
            return
        # Never poll/send_signal/kill here: Popen may reap the reserved leader.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # The unreaped leader still reserves this PGID. Never infer an
            # empty group from EPERM alone, or accept a live inaccessible member.
            if not (
                sys.platform == "darwin"
                and exited(child.pid)
                and zombie_group(child.pid)
            ):
                raise
        group_stopped = True

    stopping = False

    def request_stop(*_args: object) -> None:
        nonlocal stopping
        # In particular, never re-enter the bounded Darwin observer from a signal.
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    abandoned = False
    failed = False
    code = 1
    try:
        assert child.stdin is not None
        try:
            # The controller sends a fixed prompt under 4 KiB into this fresh
            # pipe; no other writer can fill it while stop signals are deferred.
            child.stdin.write(request["prompt"].encode())
            child.stdin.close()
        except BrokenPipeError:
            pass
        deadline = time.monotonic() + request["timeoutMs"] / 1000 + 5
        while not exited(child.pid):
            abandoned = abandoned or controller_closed(0.1)
            if stopping or time.monotonic() >= deadline or abandoned:
                terminate()
    except (
        OSError,
        RuntimeError,
        ValueError,
        AssertionError,
        subprocess.SubprocessError,
    ):
        failed = True
    finally:
        # Even a successful leader may have left live grandchildren in its group.
        # Keep the leader unreaped until this signal, then disable late signals
        # before wait() releases the PID and permits another group to reuse it.
        terminate()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        returncode = child.wait()
        code = 1 if failed else (returncode if returncode >= 0 else 128 - returncode)
        abandoned = abandoned or controller_closed(0)
        if not abandoned:
            acknowledge(code)
        else:
            # Only the private owned root is removed, never a model-provided path.
            try:
                subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-B",
                        "-c",
                        "import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)",
                        request["cleanupRoot"],
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                pass
            if controller_group is not None and os.getppid() != controller_group:
                # This guard is still a member, so this group ID cannot be reused.
                # Reclaim orphaned proxy bridges only after the model group stops.
                os.killpg(controller_group, signal.SIGKILL)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
