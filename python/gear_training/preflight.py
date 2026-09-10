"""Runtime negotiation is fail-closed; CPU contract tests do not certify GPUs."""
from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import subprocess
import sys
from pathlib import Path
from . import SLIME_COMMIT
from .content import ContentStore, digest_bytes, digest_json, require
from .hitch import HitchClient
from .placement import placement_probe_digest
from .execution import actor_rollout_placement, training_devices


def bridge_digest():
    root = Path(__file__).parent
    return digest_json([{"path": p.relative_to(root).as_posix(), "digest": digest_bytes(p.read_bytes())} for p in sorted(root.rglob("*.py"))])


def generation_protocol_digest(config):
    return digest_json({"schemaVersion": 1, "api": "chat-completions", "capture": "exact-policy-tokens-v1",
        "adapter": "slime-openai-" + SLIME_COMMIT, "native": "sglang.generate.input_ids.output_token_logprobs.v1",
        "history": "native-token-prefix-tool-results-v1",
        "wireTools": "all-sequential-v1",
        "toolParser": config.get("toolParser"), "reasoningParser": config.get("reasoningParser")})


def gpu_processes(devices):
    from .runtime_checks import parse_gpu_process_rows
    result = subprocess.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15, check=True)
    # Validate the entire observation before selecting devices. Unknown output
    # is not proof of an empty GPU and must not authorize training/eval handoff.
    return [row for row in parse_gpu_process_rows(result.stdout) if row["device"] in devices]


def compatibility_digest(request):
    parent = request["parentModel"]
    return digest_json({"backend": request["trainer"]["backend"], "runtimeLock": request["trainer"]["runtimeLock"],
        "placement": request["trainer"].get("placement", "separate"), "trainingDeviceCount": len(request["trainingDevices"]),
        "hyperparametersRef": request["trainer"]["hyperparametersRef"], "referenceModelRef": request["referenceModelRef"],
        **{k: parent[k] for k in ("architecture", "dtype", "tokenizerDigest", "chatTemplateDigest")},
        **({"deployment": request["deployment"], "trainingDevices": request["trainingDevices"]} if request.get("schemaVersion") == 2 else {})})


def missing_probe_checks(request, store):
    if request.get("schemaVersion") == 2:
        from .certification import missing_checks
        return missing_checks(request, store)
    lock = request["trainer"]["runtimeLock"]
    core_lock = {k: v for k, v in lock.items() if k not in ("validation", "probeEvidenceRefs")}
    colocated = actor_rollout_placement(request) == "colocated"
    placement_digest = placement_probe_digest(request) if colocated else None
    checks = set()
    for ref in lock.get("probeEvidenceRefs", []):
        probe = store.read_json(ref)
        if (probe.get("schemaVersion") == 1 and probe.get("kind") == "gear-training-compatibility-probe"
                and probe.get("runtimeLockIdentityDigest") == digest_json(core_lock)
                and (not colocated or probe.get("placementIdentityDigest") == placement_digest)):
            checks.update(k for k, passed in probe.get("checks", {}).items() if passed is True)
    required = {"exactTokenIds", "behaviorLogProbs", "toolContinuity", "exportReload", "hitchHarbor", "actorRolloutAlignment"}
    if colocated:
        required.update({"colocatedMemoryCycle", "colocatedCheckpointRecovery", "colocatedWeightAlignment"})
    return sorted(required - checks)


def preflight(request, config):
    lock = request["trainer"]["runtimeLock"]
    result = {"schemaVersion": 1, "trainingExternalBinding": False, "exactPolicyTokens": False, "policyFencing": False,
              "durableIdempotency": True, "checkpointEveryUpdate": True, "immutableHfExport": True, "runtimeLockDigest": digest_json(lock), "blockers": []}
    blockers = result["blockers"]
    v2 = request.get("schemaVersion") == 2
    require(request.get("schemaVersion") in (1, 2) and request["schemaVersion"] == config["schemaVersion"] and "datasets" not in request and "heldOut" not in request and "evaluation" not in request,
            "invalid-training-projection", "trainer only accepts the train-only request projection")
    require(v2 or lock.get("schemaVersion") == 1, "invalid-runtime-lock", "v1 training requires its original container runtime lock")
    devices = training_devices(request)
    if v2:
        from .node_runtime import observe_runtime
        node = request["deployment"]["modelRuntime"]
        require(config.get("node") == {key: node[key] for key in ("nodeId", "generation")}, "training-node-drift", "job belongs to another model node generation")
        if digest_json(observe_runtime()) != node["runtimeDigest"]: blockers.append("model-node-runtime-drift")
    if lock.get("validation") != "validated": blockers.append("gpu-probes-pending")
    if lock.get("slimeCommit") != SLIME_COMMIT: blockers.append("unsupported-slime-commit")
    if lock.get("bridgeDigest") != bridge_digest(): blockers.append("bridge-code-drift")
    if lock.get("protocolDigest") != generation_protocol_digest(config): blockers.append("generation-protocol-drift")
    store = ContentStore(config["storeRoot"])
    missing = missing_probe_checks(request, store)
    if missing: blockers.append("missing-runtime-probe-evidence:" + ",".join(missing))
    try:
        from .driver import build_argv
        build_argv(request, store.read_json(request["trainer"]["hyperparametersRef"]),
                   {k: "/preflight/" + k for k in ("load", "reference", "hf", "save")}, 0)
    except Exception as error:
        blockers.append("invalid-training-recipe:" + getattr(error, "code", "invalid-hyperparameters"))
    if v2:
        from .runtime_checks import validate_training_runtime
        blockers.extend(validate_training_runtime(request, config))
        # These are the bridge's native model-node protocols. Controller and
        # Harbor capabilities are checked independently on their own nodes.
        result.update(trainingExternalBinding=True, exactPolicyTokens=True, policyFencing=True)
        result["blockers"] = sorted(set(blockers))
        return result
    try:
        if not v2: asyncio.run(HitchClient(config["hitchCommand"], config["hitchRoot"]).capabilities())
        # V2's controller separately negotiates Hitch/provider capabilities. The
        # model node advertises its native protocol, without invoking Hitch.
        result.update(trainingExternalBinding=True, exactPolicyTokens=True, policyFencing=True)
    except Exception:
        blockers.append("hitch-training-capabilities-unavailable")
    try:
        sources = [("megatronPath", "megatronCommit")]
        if not v2: sources.insert(0, ("hitchPath", "hitchCommit"))
        for path_key, field in sources:
            checkout_path = Path(config[path_key])
            actual_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout_path, text=True, timeout=10).strip()
            if actual_commit != lock[field]: blockers.append(path_key + "-commit-drift")
            diff = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=checkout_path, timeout=10)
            if diff and digest_bytes(diff) not in lock["patchDigests"]: blockers.append("unlocked-patch:" + path_key)
            untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--", "src", "integrations", "slime", "megatron"], cwd=checkout_path, timeout=10)
            if untracked: blockers.append("untracked-runtime-code:" + path_key)
        import psutil
        checkout = Path(config["slimePath"])
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True, timeout=10).strip()
        if commit != lock["slimeCommit"]: blockers.append("slime-checkout-drift")
        patch = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=checkout, timeout=10)
        if patch and digest_bytes(patch) not in lock["patchDigests"]: blockers.append("unlocked-slime-patch")
        for filename in ("slime/backends/megatron_utils/actor.py", "slime/ray/actor_group.py"):
            if "def export_hf(" not in (checkout / filename).read_text(): blockers.append("missing-slime-export-extension")
        for package, field in (("torch", "pytorchVersion"), ("sglang", "sglangVersion")):
            if importlib.metadata.version(package) != lock[field]: blockers.append("runtime-package-drift:" + package)
        if ".".join(map(str, sys.version_info[:3])) != lock["pythonVersion"]: blockers.append("python-version-drift")
        if os.environ.get("GEAR_TRAINING_IMAGE_DIGEST") != lock["imageDigest"]: blockers.append("container-image-not-attested")
        import torch
        if torch.version.cuda != lock["cudaVersion"]: blockers.append("cuda-version-drift")
        if not torch.cuda.is_available(): blockers.append("cuda-unavailable")
        if gpu_processes(devices): blockers.append("training-gpu-pool-occupied")
        known = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True, timeout=10).splitlines()
        if not set(devices).issubset(set(known)): blockers.append("unknown-training-gpu")
    except Exception:
        blockers.append("locked-training-runtime-unavailable")
    return result
