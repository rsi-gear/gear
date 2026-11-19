"""Archive a stopped pre-test study without treating it as a completed comparison."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from export_formal_results import snapshot_sources
from forge_experiment import sealed_prompt
from gear.canonical import digest
from ifeval_experiment import INITIAL_HARNESS, Benchmark, read_json, write_json


def export(workspace, benchmark, output):
    identity = snapshot_sources(workspace)
    if (workspace / "summary.json").exists() or (
        workspace / "search-validity.json"
    ).exists():
        raise ValueError(
            "use the completed-study exporter after final search validation"
        )
    calls, malformed = {}, []
    pending_paths = sorted((workspace / "calls").glob("*/pending.json"))
    if {path.parent for path in pending_paths} != {
        path.parent for path in (workspace / "calls").glob("*/result.json")
    }:
        raise ValueError("model calls have unresolved submissions or orphaned results")
    for path in pending_paths:
        pending, saved = read_json(path), read_json(path.with_name("result.json"))
        request, receipt = saved["request"], saved["receipt"]
        key = request["key"]
        if (
            request != pending["request"]
            or digest(receipt) != saved["digest"]
            or digest(key).removeprefix("sha256:") != path.parent.name
            or key in calls
            or receipt["status"] != "completed"
        ):
            raise ValueError("unresolved, changed or duplicate model receipt")
        if key.startswith(("final/", "repair/")):
            raise ValueError(
                "this archive requires the final evaluation to remain unopened"
            )
        calls[key] = {
            "request": request,
            "response": receipt["response"],
            "usage": receipt["usage"],
            "status": receipt["status"],
        }
        if request["model"] == identity["config"]["teacher"]:
            try:
                json.loads(receipt["response"])
            except ValueError as error:
                malformed.append({"call_key": key, "error": str(error)})
    evaluations = {}
    training = {task["id"]: task for task in identity["splits"]["train"]}
    for path in sorted((workspace / "evaluations").glob("*.json")):
        rows = read_json(path)
        for row in rows:
            call = calls[row["call_key"]]
            if (
                row["task"] != training.get(row["task"]["id"])
                or call["request"]["prompt"] != row["task"]["prompt"]
                or call["response"] != row["response"]
                or digest(call["request"]["harness"]) != row["policy_id"]
                or benchmark.grade(row["task"], row["response"])
                != {key: row[key] for key in ("passed", "checks")}
            ):
                raise ValueError(
                    "outer evaluation does not reproduce its original receipt"
                )
        evaluations[path.stem] = rows
    runs, search_rows = {}, []
    for path in sorted(
        workspace.glob("seed-*/*/round-*/project/.gear/runs/*/journal.json")
    ):
        run = read_json(path)
        if (
            run["digest"]
            != digest({key: value for key, value in run.items() if key != "digest"})
            or run["status"] != "completed"
            or run["heldOutEvidence"]
        ):
            raise ValueError(
                "search journal is incomplete, changed, or opened held-out tasks"
            )
        frozen = read_json(path.with_name("benchmark.json"))
        harnesses = {
            candidate["id"]: sealed_prompt(
                path.parent,
                {
                    "run_id": run["id"],
                    "candidate_id": candidate["id"],
                    "digest": candidate["digest"],
                },
            )
            for candidate in run["candidates"]
        }
        for operation in run["operations"]:
            request, receipt = operation["request"], operation["receipt"]
            if request["partition"] != "seed" or operation["status"] != "complete":
                raise ValueError("search execution escaped the completed seed scope")
            if request.get("operatorCall"):
                continue
            for evidence, key in zip(
                receipt["evidence"], receipt["provenance"]["call_keys"], strict=True
            ):
                task = json.loads(frozen["verifiers"][evidence["task_id"]]["expected"])
                call = calls[key]
                feedback = json.loads(evidence["feedback"])
                measured = benchmark.grade(task, call["response"])
                if (
                    call["request"]["harness"] != harnesses[evidence["candidate_id"]]
                    or call["request"]["prompt"] != task["prompt"]
                    or feedback["answer"] != call["response"]
                    or measured
                    != {"passed": bool(evidence["score"]), "checks": feedback["checks"]}
                ):
                    raise ValueError(
                        "search evaluation does not reproduce its native receipt"
                    )
                search_rows.append({"task": task, "call_key": key, **measured})
        runs[run["id"]] = {
            "candidates": run["candidates"],
            "harnesses": harnesses,
            "journal_digest": run["digest"],
            "status": run["status"],
        }
    validation = {
        path.stem: read_json(path) for path in (workspace / "validation").glob("*.json")
    }
    for key, proof in validation.items():
        if digest(proof["draft"]).removeprefix("sha256:") != key:
            raise ValueError("validation draft changed")
        detail = proof["detail"]
        if "task" not in detail:
            continue
        reference = proof["draft"]["reference"]["answer"]
        if benchmark.grade(detail["task"], reference) != detail["reference"]:
            raise ValueError("reference grade changed")
        controls = detail.get(
            "negative_controls",
            ["", "INVALID", reference + ", EXTRA " * 100, "- a\n" * 30, "a " * 500],
        )
        if [
            benchmark.grade(detail["task"], text)["passed"] for text in controls
        ] != detail["negative_control_results"]:
            raise ValueError("original calibration results changed")
    generations = {
        str(path.relative_to(workspace)): read_json(path)
        for path in workspace.glob("seed-*/*/round-*/generation.json")
    }
    empty = [name for name, value in generations.items() if not value["tasks"]]
    # The frozen runner stops when any arm has fewer than three admitted tasks,
    # which includes nonempty shortfalls. Preserve old zero-pool exports exactly.
    shortfalls = []
    for name, value in generations.items():
        if not 0 < len(value["tasks"]) < 3:
            continue
        selected = {
            item["draft_id"]
            for report in value["reports"]
            for item in report["selection"]["selections"]
        }
        generated = [task for task in value["tasks"] if task.get("kind") == "generated"]
        if (
            len({task["id"] for task in value["tasks"]}) != len(value["tasks"])
            or {task["curriculum_draft_id"] for task in generated} != selected
            or len(generated) != len(selected)
            or any(
                task not in training.values()
                for task in value["tasks"]
                if task not in generated
            )
        ):
            raise ValueError(
                "short pool differs from its admitted generated and training tasks"
            )
        shortfalls.append(
            {"generation": name, "admitted": len(value["tasks"]), "minimum": 3}
        )
    readiness = None
    baseline = evaluations.get("baseline_train", [])
    if baseline and not runs and not generations:
        expected_keys = {"baseline/train/" + key for key in training}
        if (
            set(calls) != expected_keys
            or {row["call_key"] for row in baseline} != expected_keys
            or len(baseline) != len(training)
            or len(training) != identity["config"]["train_count"]
            or any(
                call["request"]["harness"] != INITIAL_HARNESS
                or call["request"]["model"] != identity["config"]["student"]
                for call in calls.values()
            )
        ):
            raise ValueError(
                "readiness records do not match the frozen training baseline"
            )
        passed = sum(row["passed"] for row in baseline)
        rate = passed / len(baseline)
        if not 0.25 <= rate <= 0.875:
            readiness = {
                "passed": passed,
                "count": len(baseline),
                "rate": rate,
                "allowed_range": [0.25, 0.875],
                "valid": False,
            }
    if not malformed and not empty and not shortfalls and readiness is None:
        raise ValueError(
            "no completed readiness, JSON, or generated-pool failure explains this stop"
        )
    artifact = {
        "status": "aborted_before_test",
        "identity": identity,
        "calls": calls,
        "evaluations": evaluations,
        "search_evaluations": search_rows,
        "runs": runs,
        "validation": validation,
        "generations": generations,
        "malformed_json": malformed,
        "empty_generated_pools": empty,
    }
    if readiness is not None:
        artifact["readiness_failure"] = readiness
    if shortfalls:
        artifact["insufficient_generated_pools"] = shortfalls
    manifest = {
        "status": "aborted_before_test",
        "evidence_digest": digest(artifact),
        "logical_model_calls": len(calls),
        "completed_search_runs": len(runs),
        "outer_evaluations_regraded": sum(map(len, evaluations.values())),
        "search_evaluations_regraded": len(search_rows),
        "validation_drafts": len(validation),
        "held_out_model_calls": 0,
        "malformed_json_calls": len(malformed),
        "calls_without_usage": sum(call["usage"] is None for call in calls.values()),
        "known_tokens": sum(
            call["usage"]["total"]["total_tokens"]
            for call in calls.values()
            if call["usage"]
        ),
        "http_request_count": "unknown",
        "comparison_complete": False,
        "full_selection_audit": "not_performed",
        "native_thread_and_turn_ids": "omitted",
    }
    if readiness is not None:
        manifest["stop_reason"] = "training_readiness_failed"
        manifest["readiness_failure"] = readiness
    if shortfalls:
        manifest["stop_reason"] = "too_few_validated_practices"
        manifest["insufficient_generated_pools"] = shortfalls
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "evidence.json", artifact)
    write_json(output / "manifest.json", manifest)
    print(json.dumps(manifest))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--ifeval-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    export(Path(args.workspace), Benchmark(args.ifeval_root), Path(args.output))
