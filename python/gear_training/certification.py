"""Scoped, content-addressed operator certification for the single-GPU profile.

Evidence is an operator attestation backed by retained audit artifacts, not a
cryptographic statement by the GPU vendor. No CPU test self-certifies a runtime.
Raw logs and verifier contents stay on the controller; only bounded observations
and their original artifact digests enter this public certificate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from .content import ContentStore, atomic_json, digest_json, require
from .placement import placement_probe_digest

PROFILE = "local-harbor-process-single-gpu-v1"
REQUIRED = {
    **dict.fromkeys(("exactTokenIds", "behaviorLogProbs", "toolContinuity", "exportReload", "hitchHarbor",
                    "actorRolloutAlignment", "colocatedMemoryCycle", "colocatedCheckpointRecovery",
                    "colocatedWeightAlignment", "independentEvaluationHandoff", "disconnectedAccounting"), "gpu"),
    "controlResponseRecovery": "process", "informationIsolation": "process", "generationAuthorization": "process",
    "instanceDeadlineStop": "remote-process", "remoteArtifactRetention": "remote-process",
}


def scope(request):
    deployment = request.get("deployment", {})
    task = deployment.get("taskExecution", {})
    require(request.get("schemaVersion") == 2 and task.get("placement") == "local" and task.get("provider") == "local-docker"
            and deployment.get("modelRuntime", {}).get("launcher") == "process"
            and deployment.get("gpuScheduling") == {"actorRollout": "colocated", "trainEvaluation": "sequential"}
            and len(request.get("trainingDevices", [])) == 1,
            "uncertified-runtime-profile", "this certificate covers local Harbor and one process model-node GPU only")
    lock = request["trainer"]["runtimeLock"]
    return {"profile": PROFILE, "runtimeLockIdentityDigest": digest_json({k: v for k, v in lock.items() if k not in ("validation", "probeEvidenceRefs")}),
            "placementIdentityDigest": placement_probe_digest(request), "harnessIdentityDigest": digest_json(request["fixedHarness"])}


def inspect_certificate(request, certificate):
    identity = scope(request)
    require(isinstance(certificate, dict) and set(certificate) == {"schemaVersion", "kind", "scope", "observations"}
            and certificate["schemaVersion"] == 2 and certificate["kind"] == "gear-training-compatibility-probe"
            and certificate["scope"] == identity and isinstance(certificate["observations"], list),
            "invalid-runtime-certificate", "certificate schema or tested scope differs")
    passed = set()
    for observation in certificate["observations"]:
        require(isinstance(observation, dict) and set(observation) == {"check", "method", "passed", "artifacts"},
                "invalid-runtime-certificate", "only public check observations belong in a certificate")
        check = observation["check"]
        require(check in REQUIRED and check not in passed and observation["passed"] is True
                and observation["method"] == REQUIRED[check], "invalid-runtime-certificate", "check is duplicated, failed or uses the wrong evidence method")
        artifacts = observation["artifacts"]
        require(isinstance(artifacts, list) and artifacts, "invalid-runtime-certificate", "each check needs retained audit artifact identities")
        for artifact in artifacts:
            import re
            require(isinstance(artifact, dict) and set(artifact) == {"sha256", "size"}
                    and isinstance(artifact["sha256"], str) and re.fullmatch(r"sha256:[a-f0-9]{64}", artifact["sha256"])
                    and type(artifact["size"]) is int and artifact["size"] > 0,
                    "invalid-runtime-certificate", "artifact digest and byte length are required; private paths and raw facts are excluded")
        passed.add(check)
    return sorted(set(REQUIRED) - passed)


def missing_checks(request, store):
    # V2 cannot fall back to an old unscoped boolean checklist. Malformed or
    # mismatched evidence is a blocker, never an invitation to broaden scope.
    try:
        scope(request)
        refs = request["trainer"]["runtimeLock"].get("probeEvidenceRefs", [])
        if len(refs) != 1: return sorted(REQUIRED)
        return inspect_certificate(request, store.read_json(refs[0]))
    except (ValueError, KeyError, TypeError, OSError):
        return sorted(REQUIRED)


def certify(request, audit, directory, store):
    """Seal a complete operator audit, verifying original files before publishing.

    The input must contain passed audit results bound to this precise scope.
    Source artifacts remain local, so a held-out marker cannot enter Trainer CAS
    through the certification dependency graph.
    """
    from .content import digest_file
    require(audit.get("scope") == scope(request) and audit.get("kind") == "gear-runtime-certification-audit"
            and audit.get("schemaVersion") == 1, "invalid-certification-audit", "audit must bind the actual tested runtime and layout")
    observations = []
    root = Path(directory).resolve(strict=True)
    for item in audit.get("observations", []):
        artifacts = []
        for artifact in item.get("artifacts", []):
            path = (root / artifact["path"]).resolve(strict=True)
            require(path.is_relative_to(root) and path.is_file() and path.stat().st_size == artifact["size"]
                    and digest_file(path) == artifact["sha256"], "certification-artifact-drift", "retained audit artifact differs or escapes its evidence directory")
            artifacts.append({"sha256": artifact["sha256"], "size": artifact["size"]})
        observations.append({"check": item["check"], "method": item["method"], "passed": item["passed"], "artifacts": artifacts})
    certificate = {"schemaVersion": 2, "kind": "gear-training-compatibility-probe", "scope": scope(request), "observations": observations}
    missing = inspect_certificate(request, certificate)
    require(not missing, "runtime-certification-incomplete", "missing checks: " + ",".join(missing))
    ref = store.put_json(certificate)
    return {**request["trainer"]["runtimeLock"], "validation": "validated", "probeEvidenceRefs": [ref]}


def main():
    parser = argparse.ArgumentParser(description="Seal a complete, independently audited runtime profile")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text()); audit = json.loads(args.audit.read_text())
    result = certify(request, audit, args.audit.parent, ContentStore(args.store))
    atomic_json(args.output, result)


if __name__ == "__main__": main()
