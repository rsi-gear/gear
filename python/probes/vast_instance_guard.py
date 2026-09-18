"""Detached self-stop guard using Vast's existing per-instance credential.

Only injected or original create-response instance credentials are used. A successful stop request is not proof of
termination: keep retrying until the container actually stops this process.
"""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import uuid


def write_json(path, value):
    pending = path.with_suffix(path.suffix + ".pending")
    with open(pending, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream, indent=2)
    pending.replace(path)


def credentials(instance, environ):
    assert type(instance) is int and instance > 0
    identities = [environ[key] for key in ("CONTAINER_ID", "VAST_CONTAINERLABEL") if environ.get(key)]
    assert identities and all(value in (str(instance), f"C.{instance}") for value in identities), "container identity differs"
    key = environ.get("CONTAINER_API_KEY")
    assert isinstance(key, str) and len(key) >= 16 and not any(c.isspace() for c in key), "per-instance credential unavailable"
    return key


def container_environment(environ=None, init_environment=None):
    """Read only Vast's three fields; SSH may omit Docker's original env."""
    names = ("CONTAINER_ID", "VAST_CONTAINERLABEL", "CONTAINER_API_KEY")
    current = os.environ if environ is None else environ
    selected = {name: current[name] for name in names if current.get(name)}
    if selected.get("CONTAINER_API_KEY") and any(selected.get(name) for name in names[:2]):
        return selected, "ssh-environment"
    if init_environment is None:
        with open("/proc/1/environ", "rb") as stream:
            init_environment = stream.read(1024 ** 2 + 1)
    assert len(init_environment) <= 1024 ** 2, "container init environment exceeds limit"
    for entry in init_environment.split(b"\0"):
        name, separator, value = entry.partition(b"=")
        if separator and name.decode(errors="replace") in names:
            key = name.decode()
            text = value.decode()
            assert key not in selected or selected[key] == text, "Vast identity or credential sources conflict"
            selected[key] = text
    return selected, "container-init-environment"


def install_created_credential(instance, response, environ):
    """Optional private stdin input from the saved response for this rental."""
    assert set(response) == {"success", "new_contract", "instance_api_key"}
    assert response["success"] is True and type(response["new_contract"]) is int
    assert response["new_contract"] == instance, "create response belongs to another instance"
    candidate = {name: environ[name] for name in ("CONTAINER_ID", "VAST_CONTAINERLABEL", "CONTAINER_API_KEY") if environ.get(name)}
    candidate.setdefault("CONTAINER_ID", str(instance))
    assert "CONTAINER_API_KEY" not in candidate or candidate["CONTAINER_API_KEY"] == response["instance_api_key"], "instance credentials conflict"
    candidate["CONTAINER_API_KEY"] = response["instance_api_key"]
    credentials(instance, candidate)
    environ.update(candidate)
    environ["GEAR_VAST_GUARD_CREDENTIAL_SOURCE"] = "creation-response"


def request_state(instance, key, state):
    assert state in ("running", "stopped")
    request = urllib.request.Request(f"https://console.vast.ai/api/v0/instances/{instance}/",
                                     data=json.dumps({"state": state}).encode(), method="PUT",
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=12) as response:
        content = response.read(16385)
        assert response.status == 200 and len(content) <= 16384, "instance API response invalid"
        assert json.loads(content).get("success") is True, "instance API rejected request"


def identity(pid):
    process = Path(f"/proc/{pid}/stat").read_text()
    after_name = process[process.rfind(")") + 2:].split()
    return {"pid": pid, "startTicks": int(after_name[19]),
            "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}


def guard_loop(config, directory, request, clock=time.time, sleep=time.sleep, monotonic=time.monotonic):
    """Request once at the deadline, then retry indefinitely, even after ack."""
    deadline = config["deadline"]
    assert type(deadline) in (int, float) and math.isfinite(deadline)
    assert deadline <= clock() + 2700, "deadline exceeds this diagnostic's bound"
    monotonic_end = monotonic() + max(0, deadline - clock())
    attempts = 0
    while True:
        if (directory / "stop-now.json").exists():
            assert json.loads((directory / "stop-now.json").read_text())["nonce"] == config["nonce"]
            deadline = min(deadline, clock())
        remaining = min(deadline - clock(), monotonic_end - monotonic())
        if remaining > 0:
            sleep(min(5, remaining))
            continue
        attempts += 1
        state = {"instanceId": config["instanceId"], "nonce": config["nonce"], "attempts": attempts,
                 "attemptedAt": clock(), "stopConfirmed": False}
        try:
            request()
            state["requestAccepted"] = True
        except Exception as error:
            # Never persist exception messages, request headers or credentials.
            state.update(requestAccepted=False, errorType=type(error).__name__)
        write_json(directory / "stop-attempt.json", state)
        sleep(15)


def run(directory):
    config = json.loads((directory / "config.json").read_text())
    instance = config["instanceId"]
    environment, source = container_environment()
    key = credentials(instance, environment)
    process = identity(os.getpid())
    try:
        # Already executing inside this running container; this is a no-op
        # authentication check and uses only the injected per-instance key.
        request_state(instance, key, "running")
    except Exception as error:
        write_json(directory / "startup.json", {"armed": False, "process": process, "errorType": type(error).__name__})
        config["deadline"] = time.time()
    else:
        write_json(directory / "startup.json", {"armed": True, "process": process,
                   "instanceId": instance, "nonce": config["nonce"], "deadline": config["deadline"],
                   "credentialSource": os.environ.get("GEAR_VAST_GUARD_CREDENTIAL_SOURCE", source)})
    guard_loop(config, directory, lambda: request_state(instance, key, "stopped"))


def arm(directory, instance, deadline):
    assert sys.platform == "linux", "self-stop guard requires the actual Linux instance"
    environment, _ = container_environment()
    credentials(instance, environment)
    assert math.isfinite(deadline) and time.time() < deadline <= time.time() + 2700
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    config = {"instanceId": instance, "deadline": deadline, "nonce": uuid.uuid4().hex}
    write_json(directory / "config.json", config)
    with (directory / "guard.log").open("w") as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", "--directory", str(directory)],
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    write_json(directory / "process.json", identity(process.pid))
    until = time.monotonic() + 20
    while time.monotonic() < until:
        startup = directory / "startup.json"
        if startup.exists():
            result = json.loads(startup.read_text())
            assert result["armed"], "remote self-stop authentication failed; stop from controller"
            assert result["process"] == identity(process.pid) and process.poll() is None
            assert result["instanceId"] == instance and result["nonce"] == config["nonce"]
            return result
        assert process.poll() is None, "remote self-stop guard exited before readiness"
        time.sleep(0.2)
    raise TimeoutError("remote guard readiness unknown; stop from controller")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["arm", "run", "request-stop"])
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--instance-id", type=int)
    parser.add_argument("--deadline", type=float)
    parser.add_argument("--created-credential-stdin", action="store_true")
    options = parser.parse_args()
    directory = options.directory.resolve()
    if options.created_credential_stdin:
        assert options.mode == "arm" and options.instance_id
        raw = sys.stdin.buffer.read(16385)
        assert len(raw) <= 16384, "create credential input exceeds limit"
        install_created_credential(options.instance_id, json.loads(raw), os.environ)
    if options.mode == "run":
        run(directory)
    elif options.mode == "arm":
        assert options.instance_id and options.deadline
        print(json.dumps(arm(directory, options.instance_id, options.deadline)), flush=True)
    else:
        config = json.loads((directory / "config.json").read_text())
        credentials(config["instanceId"], container_environment()[0])
        write_json(directory / "stop-now.json", {"nonce": config["nonce"]})


if __name__ == "__main__":
    main()
