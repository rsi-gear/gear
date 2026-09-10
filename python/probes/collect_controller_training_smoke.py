"""Verify and collect a completed diagnostic CAS after its rental is stopped."""
import argparse
import json
import math
from pathlib import Path

from gear_training.content import ContentStore, atomic_json, digest_file, require
from gear_training.node import dependency_refs
from gear_training.export import materialize, seal_directory


def verify_updates(store, artifacts, updates):
    require(type(updates) is int and updates in (1, 2)
            and len(artifacts["updateCommitRefs"]) == updates,
            "diagnostic-update-count", "every configured diagnostic update must be committed")
    result, runs = [], set()
    for index, ref in enumerate(artifacts["updateCommitRefs"], 1):
        commit = store.read_json(ref)
        checkpoint = store.read_json(commit["checkpointRef"])
        cursor = store.read_json(checkpoint["dataCursorRef"])
        batch = store.read_json(cursor["batchRef"])
        groups = store.read_json(batch["samplesRef"])
        require(commit["committedUpdate"] == checkpoint["committedUpdate"] == cursor["committedUpdate"] == index
                and commit["dataCursorRef"] == checkpoint["dataCursorRef"]
                and commit["consumedBatchDigest"] == cursor["batchRef"]["digest"]
                and (index == 1 or commit.get("previousCommitRef") == artifacts["updateCommitRefs"][index - 2]),
                "diagnostic-commit-drift", "checkpoint, commit chain and consumed batch must identify the same update")
        require(len(groups) == 1 and len(groups[0]) == 2,
                "diagnostic-group-drift", "two physical task runs must supply each full group")
        for sample in groups[0]:
            run = sample["metadata"]["runId"]
            require(run not in runs and sample["metadata"]["policyVersion"] == batch["policyVersion"],
                    "diagnostic-group-drift", "each update needs fresh physical runs bound to its own policy")
            require(len(sample["rollout_log_probs"]) == len(sample["loss_mask"]) == sample["response_length"]
                    and any(sample["loss_mask"]) and all(math.isfinite(x) for x in sample["rollout_log_probs"]),
                    "diagnostic-logprob-drift", "behavior logprobs and response masks must align and be finite")
            runs.add(run)
        result.append({"committedUpdate": index, "checkpointRef": commit["checkpointRef"],
                       "batchRef": cursor["batchRef"], "policyVersion": batch["policyVersion"],
                       "runs": [s["metadata"]["runId"] for s in groups[0]],
                       "rewards": [s["reward"] for s in groups[0]]})
    require(result[-1]["checkpointRef"] == artifacts["checkpointRef"],
            "diagnostic-commit-drift", "final artifact must identify the last committed checkpoint")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--source-store", required=True)
    parser.add_argument("--controller-store", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--updates", type=int, choices=(1, 2), default=1)
    options = parser.parse_args()
    artifacts = json.loads(Path(options.artifacts).read_text())
    require(artifacts["schemaVersion"] == 1 and artifacts["resourcesReleased"] is True,
            "diagnostic-not-released", "node must confirm training release before offline collection")
    source, target = ContentStore(options.source_store), ContentStore(options.controller_store)
    queue, seen, total = dependency_refs(artifacts), set(), 0
    for ref in queue:
        if ref["digest"] in seen: continue
        seen.add(ref["digest"])
        path = target.path(ref["digest"])
        if not path.exists():
            original = source.path(ref["digest"])
            require(digest_file(original) == ref["digest"], "diagnostic-cas-corrupt", "copied model-node object failed digest verification")
            require(target.put_file(original, ref["mediaType"]) == ref, "diagnostic-import-drift", "controller CAS import changed an object")
        require(digest_file(path) == ref["digest"], "diagnostic-controller-cas-corrupt", "controller object failed digest verification")
        total += path.stat().st_size
        if ref["mediaType"] == "application/json": queue.extend(dependency_refs(target.read_json(ref)))
    updates = verify_updates(target, artifacts, options.updates)
    output = Path(options.output)
    hf = materialize(target, artifacts["model"]["hfSnapshotRef"], output / "candidate-hf")
    checked = seal_directory(target, hf, serving=True, verify_finite=True)
    require(checked == artifacts["model"]["hfSnapshotRef"], "diagnostic-export-drift", "controller HF validation differs from node export")
    atomic_json(output / "collection.json", {"kind": "gear-full-driver-diagnostic-collection", "validated": False,
        "artifactsCollected": True, "verifiedObjects": len(seen), "verifiedBytes": total, "committedUpdate": options.updates,
        "modelRef": target.put_json(artifacts["model"]), "checkpointRef": artifacts["checkpointRef"],
        "batchRef": updates[-1]["batchRef"], "finiteWeightsVerified": True, "updates": updates,
        "rewards": [r for u in updates for r in u["rewards"]], "runs": [r for u in updates for r in u["runs"]]})
    print(json.dumps({"artifactsCollected": True, "committedUpdate": options.updates, "verifiedObjects": len(seen), "verifiedBytes": total, "validated": False}))


if __name__ == "__main__": main()
