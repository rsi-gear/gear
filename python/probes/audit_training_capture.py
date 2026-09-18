"""Audit native receipts against actual Slime train captures on the model node."""
import argparse
import json
import math
from pathlib import Path
import struct

from gear_training.content import ContentStore, atomic_json, digest_file, digest_json, require


def plain(value):
    return value.tolist() if hasattr(value, "tolist") else value


def fp32(value):
    return struct.unpack("f", struct.pack("f", value))[0]


def audit_sample(store, original, captured, receipts, position):
    require(captured.get("rollout_position") == captured.get("sample_index") == position,
            "capture-order-drift", "training sample order differs from the sealed batch")
    require(plain(captured["tokens"]) == original["tokens"]
            and captured["response_lengths"] == original["response_length"]
            and plain(captured["loss_masks"]) == original["loss_mask"],
            "capture-token-drift", "actual training tokens, suffix or tool masks differ")
    native = plain(captured["rollout_log_probs"])
    actor = plain(captured["log_probs"])
    require(native == [fp32(v) for v in original["rollout_log_probs"]]
            and len(actor) == len(native) == original["response_length"]
            and all(type(v) in (int, float) and math.isfinite(v) for v in actor + native),
            "capture-logprob-drift", "actual training logprobs differ or are not finite")
    sequence, mask, probs = [], [], []
    metadata = original["metadata"]
    require(metadata["receiptIds"] and len(set(metadata["receiptIds"])) == len(metadata["receiptIds"]),
            "capture-receipt-drift", "sample must bind unique ordered native receipts")
    for index, receipt_id in enumerate(metadata["receiptIds"]):
        r = receipts[receipt_id]
        require(r["complete"] is True and r["callIndex"] == index
                and r["finishReason"] in ("stop", "tool-call")
                and all(r[key] == metadata[key] for key in ("episodeId", "runId", "policyVersion")),
                "capture-receipt-drift", "native receipt does not identify this sample")
        inputs = store.read_json(r["inputTokenIdsRef"])
        outputs = store.read_json(r["outputTokenIdsRef"])
        behavior = store.read_json(r["behaviorLogProbsRef"])
        require(len(outputs) == len(behavior), "capture-receipt-drift", "native output/logprob length differs")
        if index == 0:
            sequence = list(inputs)
        else:
            require(inputs[:len(sequence)] == sequence, "capture-continuity-drift", "tool history rewrote policy tokens")
            observation = inputs[len(sequence):]
            sequence.extend(observation); mask.extend([0] * len(observation)); probs.extend([0.0] * len(observation))
        sequence.extend(outputs); mask.extend([1] * len(outputs)); probs.extend(behavior)
    require(sequence == original["tokens"] and mask == original["loss_mask"] and probs == original["rollout_log_probs"],
            "capture-native-drift", "sealed sample does not exactly reconstruct its native receipts")
    differences = [abs(a - b) for a, b, active in zip(actor, native, mask, strict=True) if active]
    require(differences, "capture-empty-loss", "sample has no policy tokens")
    return {"runId": metadata["runId"], "episodeId": metadata["episodeId"], "position": position,
            "tokenDigest": digest_json(sequence), "maskDigest": digest_json(mask), "calls": len(metadata["receiptIds"]),
            "policyTokens": len(differences), "maskedTokens": mask.count(0),
            "meanAbsoluteDifference": sum(differences) / len(differences), "maxAbsoluteDifference": max(differences)}


def audit(store, request, artifacts, capture_root, load):
    refs = artifacts["updateCommitRefs"]
    require(len(refs) == request["trainer"]["updatesPerCandidate"] and 1 <= len(refs) <= 2,
            "capture-update-count", "audit needs every configured diagnostic update")
    reports = []
    for index, ref in enumerate(refs):
        commit = store.read_json(ref)
        checkpoint = store.read_json(commit["checkpointRef"])
        cursor = store.read_json(commit["dataCursorRef"])
        batch = store.read_json(cursor["batchRef"])
        require(commit["committedUpdate"] == checkpoint["committedUpdate"] == cursor["committedUpdate"] == index + 1
                and commit["dataCursorRef"] == checkpoint["dataCursorRef"]
                and commit["consumedBatchDigest"] == cursor["batchRef"]["digest"]
                and (index == 0 or commit["previousCommitRef"] == refs[index - 1])
                and all(batch[key] == request[key] for key in ("trainingRunId", "recipeDigest", "datasetSplitDigest")),
                "capture-batch-drift", "capture audit must follow this request's actual commit chain")
        original = [sample for group in store.read_json(batch["samplesRef"]) for sample in group]
        require(original and all(s["metadata"]["policyVersion"] == batch["policyVersion"] for s in original),
                "capture-policy-drift", "samples must retain the consumed batch policy")
        receipts = {}
        for source in batch["sourceEvidenceRefs"]:
            item = store.read_json(source)
            if "inputTokenIdsRef" in item:
                require(item["id"] not in receipts or receipts[item["id"]] == item,
                        "capture-receipt-drift", "one receipt ID has conflicting native evidence")
                receipts[item["id"]] = item
        path = capture_root / f"rollout-{index}-rank-0.pt"
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16 * 1024 ** 2,
                "capture-file-invalid", "expected one bounded single-GPU capture per committed update")
        payload = load(path)
        require(payload["format_version"] == 2 and payload["rollout_id"] == index and payload["rank"] == 0
                and len(payload["samples"]) == len(original), "capture-layout-drift", "actual capture layout differs")
        samples = [audit_sample(store, row, captured, receipts, position)
                   for position, (row, captured) in enumerate(zip(original, payload["samples"], strict=True))]
        count = sum(s["policyTokens"] for s in samples)
        mean = sum(s["meanAbsoluteDifference"] * s["policyTokens"] for s in samples) / count
        require(math.isfinite(mean) and mean <= .1, "capture-actor-misaligned", "policy-token actor/native mean absolute difference exceeds 0.1")
        require(any(s["calls"] >= 2 and s["maskedTokens"] > 0 for s in samples),
                "capture-tool-evidence-missing", "each diagnostic batch needs a real multi-call tool trajectory")
        reports.append({"commitRef": ref, "batchRef": cursor["batchRef"], "policyVersion": batch["policyVersion"],
                        "capture": {"sha256": digest_file(path), "size": path.stat().st_size},
                        "meanAbsoluteDifference": mean, "samples": samples})
    require(artifacts["checkpointRef"] == store.read_json(refs[-1])["checkpointRef"],
            "capture-final-drift", "final artifacts refer to another checkpoint")
    return {"kind": "actual-training-capture-audit", "validated": False, "passed": True,
            "requestDigest": digest_json(request), "checkpointRef": artifacts["checkpointRef"], "updates": reports}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--node-config", required=True)
    parser.add_argument("--capture-root", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    from single_gpu_recovery_smoke import context
    _, service, directory, request, handle = context(options.node_config)
    status = service.inspect(handle)
    require(status["resourcesReleased"] and status["execution"] != "running", "capture-job-active", "audit after physical training release")
    config = json.loads((directory / "config.json").read_text())
    artifacts = json.loads((directory / "artifacts.body.json").read_text())
    import torch
    result = audit(ContentStore(config["storeRoot"]), request, artifacts, options.capture_root,
                   lambda path: torch.load(path, map_location="cpu", weights_only=True))
    atomic_json(options.output, result); print(json.dumps(result))


if __name__ == "__main__": main()
