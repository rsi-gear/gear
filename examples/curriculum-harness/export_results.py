"""Regrade a completed run offline and export reviewable evidence without native session IDs."""

import argparse
import hashlib
from collections import Counter, defaultdict
from pathlib import Path

from gear.canonical import digest
from ifeval_experiment import Benchmark, Experiment, read_json, write_json


def require(condition, message):
    if not condition:
        raise ValueError(message)


def local_references(value, root):
    if isinstance(value, list):
        return [local_references(item, root) for item in value]
    if isinstance(value, dict):
        return {
            "record" if key == "path" else key: (
                str(Path(item).relative_to(root))
                if key == "path"
                else local_references(item, root)
            )
            for key, item in value.items()
        }
    return value


def export(root, benchmark, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    identity = read_json(root / "identity.json")
    require(identity["source"] == benchmark.manifest, "source manifest differs")
    require(
        identity["verifier_resources"] == benchmark.resource_identity,
        "tokenizer differs",
    )
    require(
        hashlib.sha256((root / "implementation.py").read_bytes()).hexdigest()
        == identity["implementation"],
        "frozen implementation differs",
    )
    requests, receipts, costs = {}, {}, defaultdict(Counter)
    missing_usage = Counter()
    for path in sorted(root.glob("calls/*/result.json")):
        saved = read_json(path)
        request, receipt = saved["request"], saved["receipt"]
        key = request["key"]
        require(key not in requests, "duplicate call key")
        require(saved["digest"] == digest(receipt), "receipt digest changed")
        require(request["model"] == identity["config"]["model"], "model differs")
        require(
            request["effort"] == identity["config"]["effort"],
            "reasoning effort differs",
        )
        require(
            set(receipt["item_types"]) <= {"userMessage", "agentMessage", "reasoning"},
            "tool event in text experiment",
        )
        requests[key], receipts[key] = request, receipt
        # Each native thread contains one model turn. Cached input is a subset
        # of input tokens and must not be added again when totaling tokens.
        group = "/".join(key.split("/")[:2])
        costs[group]["calls"] += 1
        if receipt["usage"] is None:
            missing_usage[group] += 1
        else:
            costs[group].update(receipt["usage"]["last"])
    require(
        len(requests) == len(list(root.glob("calls/*/pending.json"))),
        "unresolved request remains",
    )
    require(len(requests) <= identity["config"]["max_calls"], "request budget exceeded")

    evaluations = {}
    for path in sorted((root / "evaluations").glob("*.json")):
        rows = read_json(path)
        for row in rows:
            request, receipt = requests[row["call_key"]], receipts[row["call_key"]]
            require(
                request["prompt"] == row["task"]["prompt"], "evaluation prompt differs"
            )
            require(
                digest(request["harness"]) == row["policy_id"],
                "evaluation harness differs",
            )
            require(
                receipt["response"] == row["response"], "evaluation response differs"
            )
            grade = benchmark.grade(row["task"], row["response"])
            require(
                grade == {"passed": row["passed"], "checks": row["checks"]},
                "independent regrade differs",
            )
        evaluations[path.stem] = rows

    splits, trace = read_json(root / "splits.json"), read_json(root / "search.json")
    train_families = {task["family"] for task in splits["train"]}
    heldout = {task["prompt"] for split in ("dev", "test") for task in splits[split]}
    all_sources = [
        task["family"] for split in ("train", "dev", "test") for task in splits[split]
    ]
    require(len(all_sources) == len(set(all_sources)), "source family leakage")
    require(len(trace) == identity["config"]["rounds"], "optimization is incomplete")
    for round_record in trace:
        for arm in round_record["arms"].values():
            require(
                len(arm["selected_tasks"]) == round_record["common_training_count"],
                "unequal learning sample count",
            )
            for task in arm["selected_tasks"]:
                require(
                    task["family"] in train_families, "training uses a heldout source"
                )
                require(task["prompt"] not in heldout, "training uses a heldout prompt")
    harnesses = read_json(root / "harnesses.json")
    tests = {
        arm: evaluations["final_" + arm]
        for arm in ("baseline", "fixed", "random", "failure")
    }
    for arm, rows in tests.items():
        require([row["task"] for row in rows] == splits["test"], "test tasks differ")
        harness = (
            identity["config"]["initial_harness"]
            if arm == "baseline"
            else harnesses[arm]
        )
        require(
            all(row["policy_id"] == digest(harness) for row in rows),
            "final harness differs",
        )
    experiment = Experiment.__new__(Experiment)
    experiment.root, experiment.student = root, identity["config"]["model"]
    summary = experiment.report(tests, trace)
    require(summary == read_json(root / "summary.json"), "recomputed summary differs")

    generated = {}
    for path in sorted(root.glob("*/round-*/generation.json")):
        value = read_json(path)
        valid_ids = set()
        for report in value["reports"]:
            for result in report["report"]["results"]:
                if all(check["status"] == "passed" for check in result["checks"]):
                    valid_ids.add(result["draft_id"])
                for check in result["checks"]:
                    for reference in check["evidence_refs"]:
                        proof_path = Path(reference["path"])
                        require(
                            proof_path.is_relative_to(root / "validation"),
                            "foreign proof",
                        )
                        require(
                            digest(read_json(proof_path)) == reference["digest"],
                            "proof changed",
                        )
        require(
            {task["id"] for task in value["tasks"]} <= valid_ids,
            "unvalidated task admitted",
        )
        # Keep target selection and outcomes; execution proof file paths stay local.
        generated[str(path.relative_to(root))] = {
            "conditioning": value["conditioning"],
            "tasks": value["tasks"],
            "memory": value["memory"],
            "targets": [report["target"] for report in value["reports"]],
            "slots": [report["slots"] for report in value["reports"]],
            "validation_results": local_references(
                [report["report"]["results"] for report in value["reports"]], root
            ),
        }
    validation = {
        str(path.relative_to(root)): read_json(path)
        for path in sorted(root.glob("validation/*.json"))
    }
    for proof in validation.values():
        if "task" in proof["detail"]:
            require(
                benchmark.grade(
                    proof["detail"]["task"], proof["draft"]["reference"]["answer"]
                )
                == proof["detail"]["reference"],
                "generated reference regrade differs",
            )
    proposals = {
        str(path.relative_to(root)): read_json(path)
        for path in sorted(root.glob("*/round-*/proposal.json"))
    }
    amendment = root / "amendment.json"
    evidence = {
        "identity": identity,
        "amendment": read_json(amendment) if amendment.exists() else None,
        "splits": splits,
        "harnesses": harnesses,
        "search": trace,
        "proposals": proposals,
        "generation": generated,
        "validation": validation,
        "evaluations": evaluations,
        "usage_by_stage": {key: dict(value) for key, value in sorted(costs.items())},
        "missing_usage_by_stage": dict(missing_usage),
        "call_audit": [
            {
                "key": key,
                "request_digest": digest(requests[key]),
                "response_digest": digest(receipts[key]["response"]),
                "usage": receipts[key]["usage"],
                "item_types": receipts[key]["item_types"],
            }
            for key in sorted(requests)
        ],
        "optimizer_and_generator_calls": {
            key: {"request": requests[key], "response": receipts[key]["response"]}
            for key in sorted(requests)
            if any(
                stage in key.split("/")
                for stage in ("optimize", "generate", "diagnose")
            )
        },
    }
    write_json(output / "summary.json", summary)
    write_json(output / "evidence.json", evidence)
    write_json(
        output / "manifest.json",
        {
            "checks": [
                "all completed request/receipt digests",
                "no unresolved requests or tool events",
                "official strict regrade of every recorded evaluation",
                "same test tasks and expected final harnesses",
                "equal learning sample counts and train/source separation",
                "generated reference regrade and validation proof digests",
                "summary recomputed from recorded evaluations",
            ],
            "files": {
                name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                for name in ("summary.json", "evidence.json")
            },
        },
    )
    print(
        f"Verified {len(requests)} model calls and exported {len(evaluations)} evaluations."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--ifeval-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    export(args.workspace, Benchmark(args.ifeval_root), args.output)
