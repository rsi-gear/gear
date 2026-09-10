"""Prepare or run a bounded Vast VM + SSH Harbor diagnostic.

The default only verifies local inputs and reads current Vast state/offers.
--run incurs charges and requires separate authorization for the second VM.
No path deletes an instance or starts the retained model instance.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.parse
import uuid

VM_TEMPLATE = "b7942f6bbc4374893ff66eb78145bbac"
VM_IMAGE = "docker.io/vastai/kvm:ubuntu_cli_22.04-2025-05-16"
MAX_HOURLY = 0.12
MAX_SECONDS = 2700


def write_json(file, value):
    pending = file.with_name(file.name + ".pending")
    pending.write_text(json.dumps(value, indent=2))
    pending.replace(file)


def sha(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def call(args, timeout=30, **kwargs):
    return subprocess.run(args, check=True, timeout=timeout, capture_output=True, text=True, **kwargs)


def instances(cli):
    result = json.loads(call([cli, "show", "instances", "--raw"]).stdout)
    assert isinstance(result, list), "Vast instance inventory is unavailable"
    return result


def stopped(state):
    return state is not None and state.get("actual_status") == "exited" and state.get("cur_state") == "stopped" and state.get("intended_status") == "stopped"


def price(value):
    assert type(value) in (int, float) and math.isfinite(value) and 0 <= value <= MAX_HOURLY, "VM price is unavailable or exceeds the cap"
    return value


def owned_instance(rows, label, model_instance, expected=None):
    matches = [row for row in rows if row.get("label") == label]
    assert len(matches) <= 1, "multiple instances have the diagnostic label; ownership is ambiguous"
    if not matches:
        return None
    state = matches[0]
    assert state["id"] != model_instance, "refusing to operate on the model instance"
    assert expected is None or state["id"] == expected, "diagnostic instance identity changed"
    return state


def safe_state(state):
    return {key: state.get(key) for key in ["id", "label", "actual_status", "cur_state", "intended_status", "dph_total", "image_uuid"]}


def safe_relative(name):
    path = PurePosixPath(name)
    assert not path.is_absolute() and path.parts and all(part not in (".", "..") for part in path.parts)
    assert str(path) == name and not any(char in name for char in "\0\r\n"), "unsafe artifact path"
    return path


def verify_inputs(root, overlay):
    manifest = json.loads((root / "worker-inputs.json").read_text())
    assert manifest["kind"] == "remote-harbor-installation-inputs" and manifest["validated"] is False
    for name, record in manifest["files"].items():
        safe_relative(name)
        file = root / name
        assert not file.is_symlink() and file.resolve().is_relative_to(root.resolve())
        assert file.stat().st_size == record["bytes"] and sha(file) == record["sha256"], f"input changed: {name}"
    expected = "".join(f"{record['sha256']}  {name}\n" for name, record in manifest["files"].items())
    assert (root / "worker-inputs.sha256").read_text() == expected, "SHA list differs from the input manifest"
    extra = json.loads((overlay / "worker-canary-overlay.json").read_text())
    archive = overlay / "worker-canary-overlay.tar.gz"
    assert sha(archive) == extra["archiveSha256"], "diagnostic overlay archive changed"
    with tarfile.open(archive) as bundle:
        assert len(bundle.getmembers()) == len(extra["files"])
        assert set(bundle.getnames()) == set(extra["files"])
        for member in bundle:
            safe_relative(member.name)
            assert member.isfile() and member.name.startswith(("dist/scripts/", "scripts/"))
            record = extra["files"][member.name]
            assert member.size == record["bytes"]
            assert hashlib.file_digest(bundle.extractfile(member), "sha256").hexdigest() == record["sha256"]
    return manifest, extra


def stop_owned(cli, label, model_instance, expected=None, seconds=70):
    """Stop only the uniquely owned VM, and require actual terminal state."""
    until = time.monotonic() + seconds
    state = owned_instance(instances(cli), label, model_instance, expected)
    if state is None:
        return None  # Missing is not a release confirmation.
    if not stopped(state):
        call([cli, "stop", "instance", str(state["id"]), "--raw"], timeout=min(30, seconds))
    while time.monotonic() < until:
        state = owned_instance(instances(cli), label, model_instance, expected)
        if stopped(state):
            return safe_state(state)
        time.sleep(3)
    raise TimeoutError("VM stop was not confirmed")


def watchdog(file):
    config = json.loads(file.read_text())
    while time.time() < config["stopAt"]:
        time.sleep(max(0, min(10, config["stopAt"] - time.time())))
    report = {"kind": "vast-harbor-watchdog", "stopped": False}
    # A controller network outage must not exhaust a small retry count and
    # silently leave a paid VM running. Only authoritative stop ends the guard.
    attempt = 0
    while not report["stopped"]:
        attempt += 1
        report["attempts"] = attempt
        try:
            state = stop_owned(config["vast"], config["label"], config["modelInstance"], seconds=60)
            if state is not None:
                report.update(stopped=True, state=state)
                break
        except Exception as error:
            report["errorType"] = type(error).__name__
        write_json(file.parent.parent / "watchdog-result.json", report)
        time.sleep(15)
    write_json(file.parent.parent / "watchdog-result.json", report)
    return 0 if report["stopped"] else 1


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--watchdog":
        return watchdog(Path(sys.argv[2]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vast", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--hitch", type=Path, required=True)
    parser.add_argument("--harbor-python", required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--model-instance", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, default=MAX_SECONDS)
    parser.add_argument("--run", action="store_true", help="Run only after the second paid VM is authorized")
    args = parser.parse_args()
    args.hitch = args.hitch.resolve()
    assert 600 <= args.max_seconds <= MAX_SECONDS
    os.umask(0o077)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    assert not (root / "lifecycle.json").exists(), "preserve the previous execution; use a new output directory"
    inputs, overlay = args.inputs.resolve(), args.overlay.resolve()
    manifest, extra = verify_inputs(inputs, overlay)
    runtime = json.loads(call([args.node, str(args.hitch / "dist/bin/hitch.js"), "training", "runtime", "--json"], timeout=30).stdout)
    assert runtime == manifest["expectedRuntime"], "controller changed after worker inputs were prepared"
    rows = instances(args.vast)
    model = next((row for row in rows if row["id"] == args.model_instance), None)
    assert stopped(model), "model instance must remain stopped during VM preparation"
    keys = json.loads(call([args.vast, "show", "ssh-keys", "--raw"]).stdout)
    assert isinstance(keys, list) and len(keys) > 0, "Vast VM requires an existing account SSH key"
    query = "vms_enabled=true num_gpus=1 cpu_ram>=8 cpu_cores_effective>=2 reliability>=0.97 disk_space>=130 compute_cap<=900 dph_total<=0.12"
    offers = json.loads(call([args.vast, "search", "offers", query, "--storage", "130", "--order", "dph_total", "--limit", "50", "--raw"]).stdout)
    eligible = [row for row in offers if row.get("vms_enabled") is True and type(row.get("dph_total")) in (int, float)
                and math.isfinite(row["dph_total"]) and 0 <= row["dph_total"] <= MAX_HOURLY and row.get("cpu_ram", 0) >= 8192
                and type(row.get("machine_id")) is int and row.get("machine_id") != model.get("machine_id")
                and row.get("cpu_cores_effective", 0) >= 2 and row.get("num_gpus") == 1]
    assert eligible, "no independent VM offer within the requested cap"
    offer = min(eligible, key=lambda row: row["dph_total"])
    label = "gear-harbor-" + uuid.uuid4().hex[:20]
    create = [args.vast, "create", "instance", str(offer["id"]), "--template_hash", VM_TEMPLATE,
              "--disk", "130", "--label", label, "--cancel-unavail", "--raw"]
    plan = {"kind": "vast-harbor-vm-execution-plan", "authorizedByThisFile": False, "createCommand": create,
            "template": VM_TEMPLATE, "expectedImage": VM_IMAGE, "offerId": offer["id"], "machineId": offer["machine_id"],
            "hourlyPrice": price(offer["dph_total"]), "maxSeconds": args.max_seconds, "modelInstance": args.model_instance,
            "modelInstanceRemainsStopped": True, "cleanup": "stop-and-retain; never delete", "inputManifestSha256": sha(inputs / "worker-inputs.json"),
            "inputShaListSha256": sha(inputs / "worker-inputs.sha256"), "overlaySha256": extra["archiveSha256"],
            "runnerSha256": sha(Path(__file__))}
    write_json(root / "plan.json", plan)
    print(json.dumps({"stage": "plan-ready", "runRequested": args.run, "hourlyPrice": plan["hourlyPrice"], "offerId": offer["id"]}), flush=True)
    if not args.run:
        return 0

    private = root / "private"
    private.mkdir(mode=0o700)
    report = {"kind": "actual-vast-harbor-diagnostic", "validated": False, "events": [], "passed": False, "instanceId": None}
    instance = None
    attempted = False
    ssh = None
    watch = None
    canary_root = None
    worker = None
    canary_attempted = False
    def event(stage, **details):
        row = {"stage": stage, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), **details}
        report["events"].append(row)
        write_json(root / "lifecycle.json", report)
        print(json.dumps(row), flush=True)
    deadline = time.monotonic() + args.max_seconds - 150
    def budget(maximum):
        left = int(deadline - time.monotonic())
        if left <= 0:
            raise TimeoutError("VM work budget exhausted; remaining time is reserved for stop")
        return min(maximum, left)
    def current():
        return owned_instance(instances(args.vast), label, args.model_instance, instance)
    def remote(command, seconds=30):
        return call([*ssh, command], timeout=budget(seconds))
    def interrupt(signum, frame):
        raise SystemExit(f"signal {signum}")
    signal.signal(signal.SIGTERM, interrupt)
    try:
        assert stopped(next(row for row in instances(args.vast) if row["id"] == args.model_instance))
        watch_file = private / "watchdog.json"
        write_json(watch_file, {"vast": args.vast, "label": label, "modelInstance": args.model_instance,
                               "stopAt": time.time() + args.max_seconds - 60})
        with (root / "watchdog.log").open("w") as log:
            watch = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--watchdog", str(watch_file)],
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        write_json(private / "watchdog-process.json", {"pid": watch.pid})
        attempted = True
        response = call(create, timeout=45)
        (private / "create-output.log").write_text(response.stdout + response.stderr)
        created = json.loads(response.stdout)
        assert created.get("success") and type(created.get("new_contract")) is int, "VM creation was not confirmed"
        instance = created["new_contract"]
        report["instanceId"] = instance
        event("created", instanceId=instance)
        until = time.monotonic() + budget(900)
        while time.monotonic() < until:
            state = current()
            assert state is not None, "created VM is missing"
            price(state.get("dph_total"))
            assert state.get("machine_id") == offer["machine_id"], "VM was assigned to a different machine"
            assert str(state.get("image_uuid", "")).removeprefix("docker.io/") == VM_IMAGE.removeprefix("docker.io/"), "VM template resolved to another image"
            if state.get("actual_status") == "running":
                break
            time.sleep(5)
        else:
            raise TimeoutError("VM image initialization exceeded its bound")
        raw = call([args.vast, "ssh-url", str(instance)]).stdout
        url = urllib.parse.urlparse(re.search(r"ssh://\S+", raw).group(0))
        assert url.hostname and url.username and url.port
        assert re.fullmatch(r"[a-zA-Z0-9_.:-]+", url.hostname) and re.fullmatch(r"[a-zA-Z0-9_-]+", url.username)
        alias = f"gear-harbor-{instance}"
        config_file = private / "ssh-config"
        config_file.write_text(f'Host {alias}\n HostName {url.hostname}\n User {url.username}\n Port {url.port}\n BatchMode yes\n ConnectTimeout 10\n StrictHostKeyChecking accept-new\n UserKnownHostsFile "{private / "known_hosts"}"\n ServerAliveInterval 10\n ServerAliveCountMax 3\n')
        ssh = ["/usr/bin/ssh", "-F", str(config_file), alias]
        until = time.monotonic() + budget(90)
        while time.monotonic() < until:
            try:
                remote("true", 12)
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                time.sleep(3)
        else:
            raise TimeoutError("VM SSH did not become ready")
        event("ssh-ready")
        remote_inputs = "/root/gear-harbor-inputs"
        install = "/opt/gear-harbor-worker"
        remote("mkdir -p " + shlex.quote(remote_inputs))
        names = list(manifest["files"]) + ["worker-inputs.json", "worker-inputs.sha256"]
        upload_list = private / "upload-files.txt"
        upload_list.write_text("".join(name + "\n" for name in names))
        shell = shlex.join(ssh[:-1])
        transfer = ["rsync", "-r", "--checksum", "--partial", "--timeout=60", "-e", shell]
        with (root / "upload.log").open("w") as log:
            subprocess.run([*transfer, "--files-from", str(upload_list), str(inputs) + "/", f"{alias}:{remote_inputs}/"],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=budget(600))
        verify = f"cd {shlex.quote(remote_inputs)} && printf '%s  %s\\n' {shlex.quote(plan['inputShaListSha256'])} worker-inputs.sha256 | sha256sum --check && sha256sum --check worker-inputs.sha256"
        with (root / "remote-input-verification.log").open("w") as log:
            subprocess.run([*ssh, verify], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=budget(120))
        event("inputs-transferred-and-verified")
        with (root / "vm-installation.log").open("w") as log:
            subprocess.run([*ssh, shlex.join(["bash", remote_inputs + "/setup_remote_harbor_worker.sh", install])],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=budget(600))
        call([*transfer, str(overlay / "worker-canary-overlay.tar.gz"), f"{alias}:{remote_inputs}/worker-canary-overlay.tar.gz"], timeout=budget(90))
        remote(f"cd {remote_inputs} && printf '%s  %s\\n' {shlex.quote(extra['archiveSha256'])} worker-canary-overlay.tar.gz | sha256sum --check && tar -xzf worker-canary-overlay.tar.gz -C {install}/hitch", 60)
        observation = remote("cat " + shlex.quote(install + "/installation-observation.json")).stdout
        write_json(root / "vm-installation-observation.json", json.loads(observation))
        worker = {"ssh_host": alias, "ssh_config": str(config_file), "runs_directory": install + "/canaries",
                  "node": install + "/node-v26.7.0-linux-x64/bin/node", "hitch": install + "/hitch",
                  "python": install + "/harbor/bin/python", "docker": remote("command -v docker").stdout.strip(), "remote_port": 32992}
        write_json(private / "worker-ssh.json", worker)
        assert stopped(next(row for row in instances(args.vast) if row["id"] == args.model_instance))
        event("remote-worker-installed")
        env = {**os.environ, "HITCH_CANARY_WORKER_SSH_CONFIG": str(private / "worker-ssh.json"),
               "HITCH_HARBOR_TEST_PYTHON": args.harbor_python, "HITCH_TRAINING_CANARY_IMAGE": manifest["taskImageId"]}
        assert budget(480) >= 350, "retain the installed VM and resume later with enough canary time"
        canary_attempted = True
        with (root / "canary.log").open("w") as log:
            child = subprocess.Popen([args.node, "dist/scripts/canary-remote-training.js"], cwd=args.hitch, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                assert child.wait(timeout=budget(480)) == 0, "cross-host canary failed"
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
        for line in (root / "canary.log").read_text().splitlines():
            try:
                result = json.loads(line)
            except json.JSONDecodeError:
                continue
            if result.get("event") == "canary-start":
                canary_root = Path(result["root"])
        assert canary_root is not None
        result = json.loads((canary_root / "summary.json").read_text())
        assert result["status"] == "passed" and result["worker_host"] == "ssh" and result["cleanup_proven"]
        write_json(root / "canary-summary.json", result)
        report["canaryPassed"] = True
        event("remote-harbor-canary-passed", evalId=result["eval_id"], runId=result["run_id"])
    except BaseException as error:
        (private / "failure.log").write_text(traceback.format_exc())
        event("failure", errorType=type(error).__name__)
    finally:
        if attempted and instance is None:
            try:
                state = current()
                if state:
                    instance = state["id"]
                    report["instanceId"] = instance
                    event("uncertain-create-resolved", instanceId=instance)
            except Exception as error:
                event("creation-resolution-failed", errorType=type(error).__name__)
        # A VM cannot use stopped per-folder Vast copy. Preserve canary records
        # and its owned peer state over SSH before stop, with a separate bound.
        if canary_attempted:
            try:
                collection_deadline = time.monotonic() + 60
                def collection_budget(maximum):
                    left = int(collection_deadline - time.monotonic())
                    if left <= 0:
                        raise TimeoutError("peer collection budget exhausted")
                    return min(maximum, left)
                for line in (root / "canary.log").read_text().splitlines():
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if item.get("event") == "canary-start":
                        canary_root = Path(item["root"])
                assert canary_root and canary_root.name.startswith("hitch-real-remote-training-")
                local_evidence = root / "canary-evidence"
                local_evidence.mkdir(exist_ok=True)
                for name in ["summary.json", "training-evidence.json", "eval-inspection.json", "worker.log", "remote-worker-location.json",
                             "remote-worker-observation.json", "remote-worker-process-stop.json", "remote-worker-docker-cleanup.json"]:
                    source = canary_root / name
                    if source.is_file():
                        shutil.copyfile(source, local_evidence / name)
                location = json.loads((canary_root / "remote-worker-location.json").read_text())
                ident = location["diagnosticId"]
                assert re.fullmatch(r"hitch-canary-[a-f0-9]{32}", ident)
                peer_root = worker["runs_directory"] + "/" + ident
                assert location["workerRoot"] == peer_root + "/worker"
                invocation = shlex.join([worker["node"], worker["hitch"] + "/dist/scripts/canary-worker-peer.js"])
                stop_result = call([*ssh, invocation], input=json.dumps({"operation": "stop", "config": worker, "id": ident}), timeout=collection_budget(20))
                process_stop = json.loads(stop_result.stdout)
                assert process_stop["workerProcessTerminal"] is True
                write_json(local_evidence / "final-peer-process-stop.json", process_stop)
                inventory_code = """from pathlib import Path
import hashlib,json,sys
root=Path(sys.argv[1]); assert root.is_dir()
files={}
for p in sorted(root.rglob('*')):
 assert not p.is_symlink(), 'symlink requires separate backup handling'
 if p.is_file():
  with p.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
  files[str(p.relative_to(root))]={'bytes':p.stat().st_size,'sha256':digest}
print(json.dumps(files))
"""
                inventory = json.loads(call([*ssh, shlex.join([worker["python"], "-c", inventory_code, peer_root])], timeout=collection_budget(20)).stdout)
                for name in inventory:
                    safe_relative(name)
                snapshot = private / "remote-peer"
                snapshot.mkdir()
                shell = shlex.join(ssh[:-1])
                # This snapshot includes the worker credential, so its entire
                # destination is private. No inference credential is sent here.
                call(["rsync", "-r", "--checksum", "--safe-links", "--partial", "--timeout=20", "-e", shell,
                      f"{worker['ssh_host']}:{shlex.quote(peer_root + '/')}", str(snapshot) + "/"], timeout=collection_budget(40))
                retained = [file for file in snapshot.rglob("*") if file.is_file()]
                copied = {str(file.relative_to(snapshot)): {"bytes": file.stat().st_size, "sha256": sha(file)} for file in retained}
                assert copied == inventory, "copied peer state differs from remote SHA-256 inventory"
                write_json(private / "remote-peer-files.json", {"verified": True, "files": copied})
                report["collectionComplete"] = True
                event("peer-evidence-collected", files=len(retained))
            except Exception as error:
                event("peer-evidence-incomplete-retain-vm", errorType=type(error).__name__)
        if instance is not None:
            try:
                state = stop_owned(args.vast, label, args.model_instance, instance)
                if state is not None:
                    write_json(root / "vast-final-state.json", state)
                    event("stopped-and-retained", instanceId=instance)
                    if watch is not None and watch.poll() is None:
                        watch.terminate()
                        watch.wait(timeout=5)
                else:
                    event("stop-unconfirmed-instance-missing")
            except Exception as error:
                event("stop-unconfirmed-watchdog-retained", errorType=type(error).__name__)
        report["passed"] = bool(report.get("canaryPassed") and report.get("collectionComplete") and (root / "vast-final-state.json").exists())
        event("finished", passed=report["passed"])
    return 0 if report["passed"] and (root / "vast-final-state.json").exists() else 1


if __name__ == "__main__":
    raise SystemExit(main())
