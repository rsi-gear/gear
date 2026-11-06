"""Root-owned Linux supervisor. Candidate code never receives its authority.

A root-owned Python chroot at /opt/kaggle-runtime, libseccomp, and a fresh
container with reserved UID 65532 are required. Unsupported kernels fail before executing candidate code.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

UID = 65532
MAX_FILE = 16 * 1024 * 1024
LIBC = ctypes.CDLL(None, use_errno=True)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def regular(path, max_bytes=MAX_FILE):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_bytes:
        raise ValueError(f'expected bounded regular file: {path}')
    return path.read_bytes()


def processes():
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            status = (path / 'status').read_text()
            for line in status.splitlines():
                if line.startswith('Uid:') and int(line.split()[1]) == UID:
                    # Zombies cannot execute or mutate outputs; parent init reaps them.
                    if '\nState:\tZ' not in '\n' + status:
                        found.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found


def stop_children():
    deadline = time.monotonic() + 5
    while True:
        pending = processes()
        if not pending:
            return
        for pid in pending:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError('candidate processes did not terminate; outputs not sealed')
        time.sleep(.02)


def preflight(runtime=Path("/opt/kaggle-runtime")):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64') or os.geteuid() != 0:
        raise RuntimeError('runner requires Linux x86_64/aarch64 and a root supervisor')
    runtime = Path(runtime)
    if not runtime.is_dir() or runtime.is_symlink():
        raise RuntimeError('root-owned /opt/kaggle-runtime Python chroot is required')
    for path in [runtime, *runtime.rglob('*')]:
        info = path.lstat()
        if not path.is_symlink() and (info.st_uid != 0 or info.st_mode & 0o022):
            raise RuntimeError(f'chroot runtime must be immutable to candidate: {path}')
    work = runtime / 'work'
    if (runtime / 'proc').exists() or work.exists() and (work.is_symlink() or any(work.iterdir())):
        raise RuntimeError('chroot must have neither /proc nor nonempty prior /work')
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    if processes():
        raise RuntimeError('reserved candidate UID is already in use')
    return seccomp


def confine(runtime):
    """The worker cannot access the host root, inherited paths or credentials."""
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    os.chroot(runtime)
    os.chdir('/work/scratch')
    os.setgroups([])
    os.setgid(UID)
    os.setuid(UID)
    if LIBC.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'no_new_privs failed')
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError('seccomp initialization failed')
    try:
        # Block all socket creation and cross-process/kernel authority; permit
        # ordinary CPU/numeric operations and subprocesses inside the chroot.
        for name in ['socket', 'socketpair', 'socketcall', 'connect', 'ptrace', 'process_vm_readv',
                     'process_vm_writev', 'mount', 'umount2', 'unshare', 'setns', 'chroot', 'bpf', 'keyctl']:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError(f'seccomp rule failed: {name}')
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError('seccomp enforcement failed')
    finally:
        seccomp.seccomp_release(context)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE, MAX_FILE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))


def seal_json(path, data):
    temporary = path.with_suffix('.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        json.dump(data, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o444)
    temporary.replace(path)


def log_tail(path, limit=4096):
    """Candidate output is data, never trusted supervisor diagnostics."""
    size = path.stat().st_size
    with path.open('rb') as stream:
        stream.seek(max(0, size - limit))
        tail = stream.read(limit).decode('utf8', errors='replace')
        # Replacement characters can expand invalid UTF-8. Bound the actual
        # serialized text bytes as well as bytes read from the log file.
        tail = tail.encode('utf8')[-limit:].decode('utf8', errors='ignore')
    return {'text': tail, 'truncated': size > limit}
