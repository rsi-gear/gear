"""Derive descriptive cost/repair metrics from the immutable V5 archive.

No model calls, new candidate selection, rewritten scores, or changes to the
original archive. Regrading remains the frozen study exporter's separate step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "python"))
from gear.canonical import digest  # noqa: E402

EVIDENCE = "sha256:4a53937dcaf9aca2aceaef61366f8c6fb7eb379930f73f595da498b73a4673d1"
SUMMARY = "sha256:52d7e0d61d64700fd20aecc69de844c9ef8829beb4ff576dcdb68968121cd702"
ARMS = ("fixed", "random", "failure", "memory")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def derive(directory):
    artifact = json.loads((directory / "evidence.json").read_text())
    summary = json.loads((directory / "summary.json").read_text())
    manifest = json.loads((directory / "manifest.json").read_text())
    require(
        digest(artifact) == manifest["evidence_digest"] == EVIDENCE
        and digest(summary) == manifest["summary_digest"] == SUMMARY,
        "this analysis requires the unchanged V5 archive",
    )
    require(
        all(summary[k] == v for k, v in artifact["summary"].items())
        and summary["costs"] == artifact["costs"]
        and set(summary["arms"]) == set(ARMS),
        "exported summary differs from its evidence",
    )
    config = artifact["identity"]["config"]
    seeds, rounds = config["seeds"], config["rounds"]
    require(seeds == [101, 202, 303] and rounds == 2, "unexpected V5 protocol")
    curves = {(row["seed"], row["round"]): row for row in summary["curve"]}
    require(
        len(curves) == len(summary["curve"]) == len(seeds) * rounds,
        "missing or duplicate optimization round",
    )
    run_owners = {}
    for (seed, index), row in curves.items():
        require(seed in seeds and index in range(rounds), "foreign round")
        require(set(row["arms"]) == set(ARMS), "incomplete paired arms")
        for arm, search in row["arms"].items():
            require(
                row["common_count"] == len(search["task_ids"]) == 6
                and search["valid_candidate"] is True
                and search["run_id"] not in run_owners,
                "unequal data budget or invalid/duplicate search",
            )
            run_owners[search["run_id"]] = (seed, arm)
    require(set(run_owners) == set(artifact["runs"]), "formal run inventory changed")

    costs = defaultdict(lambda: {"logical_calls": 0, "tokens": 0})
    for key, call in artifact["calls"].items():
        require(call["request"]["key"] == key, "native logical call identity mismatch")
        parts = key.split("/")
        if parts[0] in run_owners:
            owner = run_owners[parts[0]]
        elif parts[0].startswith("seed-"):
            owner = (int(parts[0][5:]), parts[1])
        elif parts[0] in ("final", "repair") and parts[1].startswith("seed-"):
            owner = (int(parts[1][5:]), parts[2])
        elif parts[:2] in (["baseline", "train"], ["final", "baseline"]):
            owner = (None, "shared")
        else:
            raise ValueError("unclassified model call: " + key)
        require(
            owner == (None, "shared") or owner[0] in seeds and owner[1] in ARMS,
            "foreign call owner",
        )
        require(call["usage"] is not None, "unknown usage cannot enter unit-cost ratios")
        tokens = call["usage"]["total"]["total_tokens"]
        require(type(tokens) is int and tokens >= 0, "invalid native token usage")
        costs[owner]["logical_calls"] += 1
        costs[owner]["tokens"] += tokens
    require(
        sum(row["logical_calls"] for row in costs.values())
        == summary["logical_model_calls"]
        == 1478
        and sum(row["tokens"] for row in costs.values())
        == summary["native_tokens"]["total_tokens"]
        == 13315856,
        "native call/token total mismatch",
    )
    for arm in (*ARMS, "shared"):
        rows = [v for (seed, group), v in costs.items() if group == arm]
        declared = [
            v for name, v in artifact["costs"]["groups"].items() if name.startswith(arm + "/")
        ]
        require(
            sum(row["logical_calls"] for row in rows)
            == sum(row["logical_calls"] for row in declared)
            and sum(row["tokens"] for row in rows) == sum(row["known_tokens"] for row in declared)
            and all(row["calls_without_usage"] == 0 for row in declared),
            "exported cost ownership mismatch: " + arm,
        )

    evaluations = artifact["evaluations"]
    split = artifact["identity"]["splits"]
    task_sets = {name: {row["id"]: row for row in split[name]} for name in ("train", "dev", "test")}
    for left, right in (("train", "dev"), ("train", "test"), ("dev", "test")):
        require(not task_sets[left].keys() & task_sets[right].keys(), "task partitions overlap")
        require(
            not {row["family"] for row in task_sets[left].values()}
            & {row["family"] for row in task_sets[right].values()},
            "source families overlap",
        )

    def checked_rows(name, partition):
        rows = evaluations[name]
        tasks = task_sets[partition]
        require(
            len(rows) == len(tasks) and {row["task"]["id"] for row in rows} == tasks.keys(),
            "evaluation task inventory mismatch",
        )
        for row in rows:
            call = artifact["calls"][row["call_key"]]
            require(
                type(row["passed"]) is bool
                and row["task"] == tasks[row["task"]["id"]]
                and row["response"] == call["response"]
                and row["task"]["prompt"] == call["request"]["prompt"]
                and row["policy_id"] == digest(call["request"]["harness"]),
                "evaluation is not bound to its original request and response",
            )
        return rows

    baseline = checked_rows("final_baseline", "test")
    train = checked_rows("baseline_train", "train")
    baseline_passed = sum(row["passed"] for row in baseline)
    require(baseline_passed == summary["baseline_test_passed"] == 22, "baseline score mismatch")
    failures = {row["task"]["id"] for row in train if not row["passed"]}
    successes = {row["task"]["id"] for row in train if row["passed"]}
    shared = costs[None, "shared"]
    # Allocate the one shared baseline equally to 4 arms × 3 trials. It is not
    # twelve fresh baseline samples; the numerator still uses the same 22/24.
    baseline_share = shared["tokens"] / (len(ARMS) * len(seeds))
    trials = []
    for arm in ARMS:
        for seed in seeds:
            test = checked_rows(f"final_seed-{seed}_{arm}", "test")
            repair = checked_rows(f"repair_seed-{seed}_{arm}", "train")
            middle = checked_rows(f"seed-{seed}_{arm}_round-1_diagnostic", "train")
            harness = curves[seed, rounds - 1]["arms"][arm]["harness"]
            require(
                all(row["policy_id"] == digest(harness) for row in test + repair),
                "final evaluation policy changed",
            )
            passed = sum(row["passed"] for row in test)
            fixed = checked_rows(f"final_seed-{seed}_fixed", "test")
            random = checked_rows(f"final_seed-{seed}_random", "test")
            recorded = next(row for row in summary["arms"][arm] if row["seed"] == seed)
            repairs = sum(row["passed"] for row in repair if row["task"]["id"] in failures)
            regressions = sum(not row["passed"] for row in repair if row["task"]["id"] in successes)
            require(
                (
                    recorded["test_passed"],
                    recorded["old_failure_repairs"],
                    recorded["old_success_regressions"],
                )
                == (passed, repairs, regressions),
                "reported repair/regression counts differ from task evidence",
            )
            owned = costs[seed, arm]
            accounted = owned["tokens"] + baseline_share
            delta_pp = 100 * (passed - baseline_passed) / len(baseline)
            trials.append(
                {
                    "seed": seed,
                    "arm": arm,
                    "test_passed": passed,
                    "test_count": len(test),
                    "net_test_passes_vs_shared_baseline": passed - baseline_passed,
                    "delta_pp_vs_baseline": delta_pp,
                    "delta_pp_vs_fixed": 100
                    * (passed - sum(row["passed"] for row in fixed))
                    / len(test),
                    "delta_pp_vs_random": 100
                    * (passed - sum(row["passed"] for row in random))
                    / len(test),
                    "old_failure_repairs": repairs,
                    "old_failures": len(failures),
                    "old_success_regressions": regressions,
                    "old_successes": len(successes),
                    "training_curve_passed": [
                        sum(row["passed"] for row in rows) for rows in (train, middle, repair)
                    ],
                    "logical_calls_excluding_shared": owned["logical_calls"],
                    "tokens_excluding_shared": owned["tokens"],
                    "allocated_shared_baseline_tokens": baseline_share,
                    "accounted_tokens": accounted,
                    "delta_pp_per_million_accounted_tokens": 1e6 * delta_pp / accounted,
                    "conditional_task_bootstrap_interval_per_million_tokens": [
                        1e8 * x / accounted
                        for x in recorded["vs_baseline"]["paired_bootstrap_95_ci"]
                    ],
                    "changed_final_harness": digest(harness) != baseline[0]["policy_id"],
                }
            )
    arms = {}
    for arm in ARMS:
        rows = [row for row in trials if row["arm"] == arm]
        accounted = sum(row["accounted_tokens"] for row in rows)
        net = sum(row["net_test_passes_vs_shared_baseline"] for row in rows)
        arms[arm] = {
            "trials": len(rows),
            "test_executions": len(rows) * len(baseline),
            "unique_test_tasks": len(baseline),
            "mean_test_pass_rate": sum(row["test_passed"] for row in rows)
            / (len(rows) * len(baseline)),
            "logical_calls_excluding_shared": sum(
                row["logical_calls_excluding_shared"] for row in rows
            ),
            "tokens_excluding_shared": sum(row["tokens_excluding_shared"] for row in rows),
            "allocated_shared_baseline_tokens": shared["tokens"] / len(ARMS),
            "accounted_tokens": accounted,
            "net_repeated_test_passes_vs_shared_baseline": net,
            "net_repeated_test_passes_per_million_accounted_tokens": 1e6 * net / accounted,
            "old_failure_repairs": sum(row["old_failure_repairs"] for row in rows),
            "old_failure_observations": sum(row["old_failures"] for row in rows),
            "old_success_regressions": sum(row["old_success_regressions"] for row in rows),
            "old_success_observations": sum(row["old_successes"] for row in rows),
            "changed_final_harnesses": sum(row["changed_final_harness"] for row in rows),
        }
    return {
        "schema_version": 1,
        "source_evidence_digest": EVIDENCE,
        "source_summary_digest": SUMMARY,
        "derivation_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_model_calls": 1478,
        "source_native_tokens": 13315856,
        "new_model_calls": 0,
        "weight_training_steps": 0,
        "shared_baseline": shared,
        "cost_denominator": "All owned native input+output tokens, including diagnosis, generation, search, probes and final evaluation, plus an equal share of the one shared baseline. Cached input is already included.",
        "excluded_or_unknown_costs": {
            "validation_cpu_time": "not_measured",
            "validation_verifier_calls": 676,
            "dollars": "not_estimated",
            "http_retries": "unknown",
            "prior_studies_and_availability_probes": "excluded",
        },
        "interpretation": "Descriptive score-to-token ratios only. Baseline and 24 test tasks are shared across trials, and native decoding is not seeded. Task bootstrap intervals do not capture optimization or model randomness. No confirmed causal failure-data gain or economic ROI.",
        "trials": trials,
        "arms": arms,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=REPOSITORY / "research/curriculum-harness-2026-11-20-v5"
    )
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("unit-cost.json"))
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    result = derive(args.source)
    if args.verify or args.output.exists():
        require(
            json.loads(args.output.read_text()) == result,
            "derived artifact differs from original evidence or script",
        )
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": "verified" if args.verify else "derived",
                "trials": len(result["trials"]),
                "source_tokens": result["source_native_tokens"],
                "new_model_calls": 0,
            }
        )
    )


if __name__ == "__main__":
    main()
