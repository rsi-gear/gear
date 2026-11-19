"""Verify and export formal-study evidence without native thread IDs or credentials."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from gear.canonical import digest
from ifeval_experiment import (
    Benchmark,
    negative_controls,
    paired_comparison,
    read_json,
    write_json,
)


def snapshot_sources(workspace):
    identity = read_json(workspace / "identity.json")
    source_root = Path(__file__).resolve().parents[2]
    for name, expected in identity["implementation"].items():
        target = workspace / "source_snapshot" / name
        source = target if target.exists() else source_root / name
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(
                "study implementation differs from its frozen identity: " + name
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(data)
    return identity


def export(workspace, benchmark, output, *, language_seed=None):
    if language_seed is not None:
        from langdetect import DetectorFactory

        DetectorFactory.seed = language_seed
        if hasattr(benchmark, "verifier_policy"):
            benchmark.verifier_policy["language_detection_seed"] = language_seed
    identity = snapshot_sources(workspace)
    if not read_json(workspace / "search-validity.json")["valid"]:
        raise ValueError("study did not meet the predeclared comparison criterion")
    summary = read_json(workspace / "summary.json")
    validation = {
        path.stem: read_json(path) for path in (workspace / "validation").glob("*.json")
    }
    by_draft = {}
    for name, proof in validation.items():
        if name != digest(proof["draft"]).removeprefix("sha256:"):
            raise ValueError("validation draft bytes changed")
        by_draft[proof["draft"]["draft_id"]] = proof
    calls = {}
    for path in sorted((workspace / "calls").glob("*/result.json")):
        saved, pending = read_json(path), read_json(path.with_name("pending.json"))
        if saved["request"] != pending["request"] or saved["digest"] != digest(
            saved["receipt"]
        ):
            raise ValueError("model request/receipt changed")
        receipt = saved["receipt"]
        if receipt["status"] != "completed":
            raise ValueError("failed model turn cannot be reported as completed data")
        key = saved["request"]["key"]
        if key in calls:
            raise ValueError("duplicate logical model call")
        calls[key] = {
            "request": saved["request"],
            "response": receipt["response"],
            "usage": receipt["usage"],
            "recovered": receipt.get("recovered", False),
            "item_types": receipt["item_types"],
        }
    if len(list((workspace / "calls").glob("*/pending.json"))) != len(calls):
        raise ValueError("unresolved model calls remain")
    evaluations = {}
    for path in sorted((workspace / "evaluations").glob("*.json")):
        rows = read_json(path)
        for row in rows:
            call = calls[row["call_key"]]
            if (
                call["response"] != row["response"]
                or call["request"]["prompt"] != row["task"]["prompt"]
                or digest(call["request"]["harness"]) != row["policy_id"]
            ):
                raise ValueError(
                    "evaluation does not match the original native response"
                )
            measured = benchmark.grade(row["task"], row["response"])
            if measured != {key: row[key] for key in ("passed", "checks")}:
                raise ValueError("official verifier does not reproduce a saved result")
        evaluations[path.stem] = rows
    baseline = evaluations["final_baseline"]
    if summary["baseline_test_passed"] != sum(row["passed"] for row in baseline):
        raise ValueError("baseline total differs from measured results")
    for arm, seeds in summary["arms"].items():
        for value in seeds:
            seed = value["seed"]
            rows = evaluations[f"final_seed-{seed}_{arm}"]
            if value["test_passed"] != sum(row["passed"] for row in rows):
                raise ValueError("arm total differs from measured results")
            for control in ("baseline", "fixed", "random"):
                reference = (
                    baseline
                    if control == "baseline"
                    else evaluations[f"final_seed-{seed}_{control}"]
                )
                if paired_comparison(rows, reference) != value["vs_" + control]:
                    raise ValueError("reported paired comparison is not reproducible")
    runs, run_arms, call_kinds = {}, {}, {}
    search_evaluations, language_changes, selection_changes = {}, [], []
    for record in summary["curve"]:
        for arm, search in record["arms"].items():
            run_id = search["run_id"]
            run_arms[run_id] = arm
            project = (
                workspace
                / f"seed-{record['seed']}"
                / arm
                / f"round-{record['round']}"
                / "project"
            )
            journal = read_json(project / ".gear/runs" / run_id / "journal.json")
            if (
                digest({key: val for key, val in journal.items() if key != "digest"})
                != journal["digest"]
            ):
                raise ValueError("formal run journal changed")
            if journal["nomineeId"] is not None or journal["heldOutEvidence"]:
                raise ValueError("held-out gate was used during optimization")
            train_ids = set(search["task_ids"])
            dev_ids = {task["id"] for task in identity["splits"]["dev"]}
            if (
                train_ids & dev_ids
                or {task["id"] for task in journal["spec"]["seedTasks"]}
                != train_ids | dev_ids
                or set(journal["spec"]["heldOutTaskIds"])
                != {task["id"] for task in identity["splits"]["test"]}
            ):
                raise ValueError("formal admission or train/validation scope changed")
            run_root = project / ".gear/runs" / run_id
            frozen = read_json(run_root / "benchmark.json")
            if (
                digest({k: v for k, v in frozen.items() if k != "digest"})
                != frozen["digest"]
                or frozen["digest"] != journal["spec"]["benchmarkDigest"]
            ):
                raise ValueError("admitted benchmark bytes changed")
            harnesses = {}
            for candidate in journal["candidates"]:
                name = candidate["id"]
                manifest = read_json(run_root / "target-manifests" / (name + ".json"))
                text = (run_root / "targets" / name / "AGENTS.md").read_text()
                resource = next(
                    r for r in manifest["resources"] if r["path"] == "AGENTS.md"
                )
                if (
                    candidate["digest"] != manifest["digest"]
                    or digest({k: v for k, v in manifest.items() if k != "digest"})
                    != manifest["digest"]
                    or resource["digest"]
                    != digest(base64.b64encode(text.encode()).decode())
                ):
                    raise ValueError("sealed search candidate changed")
                harnesses[name] = text
            measured_rows = []
            for operation in journal["operations"]:
                request, receipt = operation["request"], operation["receipt"]
                if operation["status"] != "complete":
                    raise ValueError("unfinished formal operation")
                saved = read_json(
                    workspace
                    / "operations"
                    / request["operationId"].removeprefix("sha256:")
                    / "receipt.json"
                )
                # Runtime binds pass_rate measurement identity after receiving
                # the provider receipt; verify that projection explicitly below.
                original = {
                    **receipt,
                    "evidence": [
                        {k: v for k, v in row.items() if k != "raw_metrics"}
                        for row in receipt["evidence"]
                    ],
                }
                if (
                    saved["digest"] != digest(saved["receipt"])
                    or saved["receipt"] != original
                ):
                    raise ValueError(
                        "native provider receipt and formal journal disagree"
                    )
                keys = receipt["provenance"]["call_keys"]
                if request.get("operatorCall"):
                    if set(request["operation"]["task_ids"]) != train_ids:
                        raise ValueError(
                            "reflection included material outside its training scope"
                        )
                    if (
                        len(keys) != 1
                        or json.loads(calls[keys[0]]["response"])
                        != receipt["result"]["data"]["data"]
                    ):
                        raise ValueError(
                            "Meta proposal differs from its model response"
                        )
                    continue
                if len(keys) != len(request["slots"]) or len(keys) != len(
                    receipt["evidence"]
                ):
                    raise ValueError("formal evaluation has missing or duplicate slots")
                for key, slot, evidence in zip(
                    keys, request["slots"], receipt["evidence"], strict=True
                ):
                    task = json.loads(frozen["verifiers"][slot["taskId"]]["expected"])
                    if task.get("kind") == "generated":
                        proof = by_draft[task["curriculum_draft_id"]]
                        admitted = {
                            **proof["detail"]["task"],
                            "curriculum_conditioning": proof["draft"]["plan"][
                                "conditioning"
                            ],
                        }
                        if task != admitted or not all(proof["facts"].values()):
                            raise ValueError(
                                "an unverified generated task entered a search run"
                            )
                    call = calls[key]
                    feedback = json.loads(evidence["feedback"])
                    candidate = request["operation"]["candidate_id"]
                    candidate_digest = next(
                        c["digest"]
                        for c in journal["candidates"]
                        if c["id"] == candidate
                    )
                    contract = next(
                        m for m in request["metrics"] if m["id"] == "pass_rate"
                    )
                    bound_metric = {
                        "contractDigest": contract["digest"],
                        "unit": contract["unit"],
                        "status": "available",
                        "value": int(evidence["score"] == 1),
                        "evidenceRefs": [
                            digest(
                                {
                                    "benchmark": journal["spec"]["benchmarkDigest"],
                                    "provider": journal["spec"].get(
                                        "evaluationIdentity"
                                    )
                                    or journal["spec"]["providerIdentity"],
                                    "candidate": candidate_digest,
                                    "task": evidence["task_id"],
                                    "repetition": evidence["repetition"],
                                    "score": evidence["score"],
                                    "status": evidence["status"],
                                }
                            )
                        ],
                    }
                    if evidence["raw_metrics"] != {"pass_rate": bound_metric}:
                        raise ValueError(
                            "runtime measurement projection does not reproduce"
                        )
                    if (
                        key
                        != f"{run_id}/{request['operationId']}/{slot['taskId']}/{slot['repetition']}"
                        or task["id"] != slot["taskId"]
                        or evidence["task_id"] != task["id"]
                        or evidence["repetition"] != slot["repetition"]
                        or evidence["candidate_id"] != candidate
                        or call["request"]["prompt"] != task["prompt"]
                        or call["request"]["harness"] != harnesses[candidate]
                        or feedback["answer"] != call["response"]
                    ):
                        raise ValueError(
                            "formal evaluation is not bound to its task and capture"
                        )
                    grade = benchmark.grade(task, call["response"])
                    recorded = {
                        "passed": bool(evidence["score"]),
                        "checks": feedback["checks"],
                    }
                    if evidence["status"] != "valid" or recorded["passed"] != all(
                        recorded["checks"].values()
                    ):
                        raise ValueError("invalid recorded search score")
                    if recorded != grade:
                        changed = {
                            k
                            for k in grade["checks"]
                            if grade["checks"][k] != recorded["checks"].get(k)
                        }
                        if (
                            language_seed is None
                            or set(recorded["checks"]) != set(grade["checks"])
                            or not changed
                            or any(
                                k.split(":", 1)[1]
                                not in (
                                    "change_case:english_capital",
                                    "change_case:english_lowercase",
                                )
                                for k in changed
                            )
                        ):
                            raise ValueError("formal search score does not reproduce")
                        language_changes.append(
                            {
                                "run_id": run_id,
                                "task_id": task["id"],
                                "candidate_id": candidate,
                                "recorded": recorded,
                                "regraded": grade,
                            }
                        )
                    measured_rows.append(
                        {
                            "call_key": key,
                            "task": task,
                            "candidate_id": candidate,
                            "recorded": recorded,
                            **grade,
                        }
                    )
            search_evaluations[run_id] = measured_rows
            comparison = search["outcome"]["history"][0]
            child = comparison["candidate"]["candidate_id"]
            totals = {
                name: sum(
                    row["passed"]
                    for row in measured_rows
                    if row["candidate_id"] == name and row["task"]["id"] in dev_ids
                )
                for name in ("anchor", child)
            }
            regraded_acceptance = totals[child] > totals["anchor"]
            if regraded_acceptance != comparison["accepted"]:
                selection_changes.append(
                    {
                        "run_id": run_id,
                        "seed": record["seed"],
                        "arm": arm,
                        "round": record["round"],
                        "recorded_accepted": comparison["accepted"],
                        "regraded_accepted": regraded_acceptance,
                        "dev_passed": totals,
                    }
                )
            for call in journal["operators"]["calls"]:
                for operation in call["operationIds"]:
                    call_kinds[run_id + "/" + operation] = (
                        "prompt_repair"
                        if "/revise/" in call["call"]["key"]
                        else "prompt_proposal"
                        if call["call"]["effect"]["kind"] == "meta"
                        else "search_evaluation"
                    )
            runs[run_id] = {
                "benchmark_digest": journal["spec"]["benchmarkDigest"],
                "status": journal["status"],
                "candidates": journal["candidates"],
                "harnesses": harnesses,
                "selected": search["selected"],
                "physical_attempts": journal["physicalAttempts"],
                "decisions": [
                    {
                        "records": entry["decision"]["records"],
                        "reason": entry["decision"]["reason"],
                    }
                    for entry in journal["operators"]["decisions"]
                ],
            }
    costs = defaultdict(
        lambda: {"logical_calls": 0, "known_tokens": 0, "calls_without_usage": 0}
    )
    for key, call in calls.items():
        parts = key.split("/")
        if parts[0] in run_arms:
            arm, category = run_arms[parts[0]], call_kinds["/".join(parts[:2])]
        elif parts[0].startswith("seed-"):
            arm = parts[1]
            category = (
                "data_generation"
                if "/generate/" in key
                else "diagnosis"
                if "/diagnose" in key
                else "training_feedback"
            )
        elif parts[0] in ("final", "repair") and parts[1].startswith("seed-"):
            arm, category = (
                parts[2],
                "test" if parts[0] == "final" else "regression_probe",
            )
        else:
            arm, category = "shared", "baseline"
        row = costs[arm + "/" + category]
        row["logical_calls"] += 1
        if call["usage"] is None:
            row["calls_without_usage"] += 1
        else:
            row["known_tokens"] += call["usage"]["total"]["total_tokens"]
    for proof in validation.values():
        detail = proof["detail"]
        if "task" in detail:
            grade = benchmark.grade(
                detail["task"], proof["draft"]["reference"]["answer"]
            )
            if grade != detail["reference"]:
                raise ValueError("generated reference validation is not reproducible")
            reference = proof["draft"]["reference"]["answer"]
            controls = detail.get(
                "negative_controls",
                [
                    "",
                    "INVALID",
                    reference + ", EXTRA " * 100,
                    "- a\n" * 30,
                    "a " * 500,
                ],
            )
            if "negative_controls" in detail and controls != negative_controls(
                detail["task"], reference
            ):
                raise ValueError(
                    "calibration controls differ from the declared construction"
                )
            if [
                benchmark.grade(detail["task"], text)["passed"] for text in controls
            ] != detail["negative_control_results"]:
                raise ValueError("negative verifier calibration is not reproducible")
    usage = {
        "groups": dict(sorted(costs.items())),
        "validation_drafts": len(validation),
        "validation_verifier_calls": sum(
            1 + len(proof["detail"]["negative_control_results"])
            for proof in validation.values()
            if "reference" in proof["detail"]
        ),
        "validation_cpu_time": "not_measured",
        "weight_training_steps": 0,
        "http_request_count": "unknown",
        "unit": "native tokens; no dollar price assumed",
    }
    artifact = {
        "identity": identity,
        "summary": summary,
        "costs": usage,
        "evaluations": evaluations,
        "search_evaluations": search_evaluations,
        "calls": calls,
        "runs": runs,
        "validation": validation,
        "verifier_audit": {
            "original_language_seed": identity.get("verifier_policy", {}).get(
                "language_detection_seed"
            ),
            "audit_language_seed": getattr(benchmark, "verifier_policy", {}).get(
                "language_detection_seed", language_seed
            ),
            "check_differences": language_changes,
            "selection_differences": selection_changes,
            "harnesses_reselected": False,
            "new_model_calls": 0,
        },
    }
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "evidence.json", artifact)
    exported_summary = {
        **summary,
        "costs": usage,
        "verifier_audit": artifact["verifier_audit"],
    }
    write_json(output / "summary.json", exported_summary)
    write_json(
        output / "manifest.json",
        {
            "version": 1,
            "evidence_digest": digest(artifact),
            "summary_digest": digest(exported_summary),
            "model_calls": len(calls),
            "official_verifier_regrade": "stochastic_language_check_differences"
            if language_changes
            else "passed",
            "outer_evaluations_regraded": sum(
                len(rows) for rows in evaluations.values()
            ),
            "search_evaluations_regraded": sum(
                len(rows) for rows in search_evaluations.values()
            ),
            "native_thread_ids_exported": False,
        },
    )
    print(
        f"Verified {len(calls)} logical calls, {len(runs)} formal runs and {len(validation)} drafts"
    )


def verify_export(directory, benchmark):
    """Regrade the shareable archive without native sessions or model access."""
    artifact = read_json(directory / "evidence.json")
    manifest = read_json(directory / "manifest.json")
    if digest(artifact) != manifest["evidence_digest"]:
        raise ValueError("exported evidence digest changed")
    if digest(read_json(directory / "summary.json")) != manifest["summary_digest"]:
        raise ValueError("exported summary digest changed")
    seed = artifact["verifier_audit"]["audit_language_seed"]
    if seed is not None:
        benchmark.verifier_policy["language_detection_seed"] = seed
    count = 0
    for rows in artifact["evaluations"].values():
        for row in rows:
            if benchmark.grade(row["task"], row["response"]) != {
                k: row[k] for k in ("passed", "checks")
            }:
                raise ValueError("exported outer evaluation changed")
            count += 1
    for rows in artifact["search_evaluations"].values():
        for row in rows:
            call = artifact["calls"][row["call_key"]]
            if benchmark.grade(row["task"], call["response"]) != {
                k: row[k] for k in ("passed", "checks")
            }:
                raise ValueError("exported search regrade changed")
            count += 1
    for proof in artifact["validation"].values():
        detail = proof["detail"]
        if "task" not in detail:
            continue
        if (
            benchmark.grade(detail["task"], proof["draft"]["reference"]["answer"])
            != detail["reference"]
        ):
            raise ValueError("exported reference validation changed")
        controls = detail.get(
            "negative_controls",
            [
                "",
                "INVALID",
                proof["draft"]["reference"]["answer"] + ", EXTRA " * 100,
                "- a\n" * 30,
                "a " * 500,
            ],
        )
        if "negative_controls" in detail and controls != negative_controls(
            detail["task"], proof["draft"]["reference"]["answer"]
        ):
            raise ValueError("exported calibration control construction changed")
        if [
            benchmark.grade(detail["task"], text)["passed"] for text in controls
        ] != detail["negative_control_results"]:
            raise ValueError("exported negative-control validation changed")
    if (
        count
        != manifest["outer_evaluations_regraded"]
        + manifest["search_evaluations_regraded"]
    ):
        raise ValueError("exported evaluation count changed")
    print(
        f"Archive digest and {count} recorded LLM evaluations verified; original stochastic-grader differences remain declared"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace")
    parser.add_argument("--ifeval-root")
    parser.add_argument("--output")
    parser.add_argument("--snapshot-only", action="store_true")
    parser.add_argument(
        "--verify-export",
        help="Verify a shareable archive without native session records",
    )
    parser.add_argument(
        "--audit-language-seed",
        type=int,
        help="Explicit retrospective language-detector audit; preserves original decisions and flags every difference",
    )
    args = parser.parse_args()
    if args.verify_export:
        if not args.ifeval_root:
            parser.error("--verify-export requires --ifeval-root")
        verify_export(Path(args.verify_export), Benchmark(args.ifeval_root))
        raise SystemExit(0)
    if not args.workspace:
        parser.error("export requires --workspace")
    workspace = Path(args.workspace).resolve()
    if args.snapshot_only:
        snapshot_sources(workspace)
        print("Caller and operator source bytes match the frozen study identity")
    else:
        if not args.ifeval_root or not args.output:
            parser.error("export requires --ifeval-root and --output")
        export(
            workspace,
            Benchmark(args.ifeval_root),
            Path(args.output).resolve(),
            language_seed=args.audit_language_seed,
        )
