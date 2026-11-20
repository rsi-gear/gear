"""Verify the interrupted V6 study with native CPU replay and no model SDK."""

import argparse
import asyncio
import base64
import copy
import hashlib
import json
import sys
import tempfile
from pathlib import Path

from prefix import verify_prefix
from records import read, require, verify_record

ARCHIVE = Path(__file__).resolve().parent


async def verify(evidence, repository, source):
    from formal_provider import prepare_jobs
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from gear.search import PromptConstraints
    from model_calls import BASE_INSTRUCTIONS, token_usage
    from sentinel_generate import implementation_identity
    from sentinel_pool import build_pool
    from sentinel_retail import RetailSession, calibrate, load_backend, validate_task

    def sealed(value):
        require(
            digest({key: item for key, item in value.items() if key != "digest"})
            == value["digest"],
            "sealed artifact changed",
        )

    identity, protocol, search = (
        evidence["study_identity"],
        evidence["protocol"],
        evidence["search"],
    )
    config = identity["config"]
    require(
        config == read(ARCHIVE / "config.json")
        and protocol == read(ARCHIVE / "protocol.json")
        and digest(config) == protocol["config_digest"]
        and protocol["source_commit"] == "f5947efb596d4ceeac8e1ba887364b0dd2f08bb8"
        and identity["implementation"] == implementation_identity()
        and identity["model_calls"]["fixture"] is False
        and evidence["completed_study"] is False
        and evidence["final_test_opened"] is False
        and evidence["comparative_effect"] is None,
        "source, protocol or stopped classification changed",
    )
    for name, expected in identity["search_implementation"].items():
        require(
            hashlib.sha256((repository / name).read_bytes()).hexdigest() == expected,
            "formal implementation changed",
        )
    backend = load_backend(source)
    require(backend["identity"] == identity["backend"], "native backend changed")
    partitions = {
        "train": [
            {
                "partition": "train",
                **{key: config["training"][key] for key in ("family", "database", "user_id")},
                **row,
            }
            for row in config["training"]["fixed"]
        ],
        "validation": config["validation"],
        "test": config["test"],
    }
    ids, fingerprints, families = set(), set(), {}
    for partition, bundles in partitions.items():
        families[partition] = set()
        for bundle in bundles:
            task = validate_task(bundle["task"], bundle["reference"])
            session = RetailSession(backend, bundle["database"], bundle["user_id"])
            fingerprint = digest(
                [
                    session.identity,
                    {
                        key: value
                        for key, value in task.model_dump(mode="json").items()
                        if key != "id"
                    },
                ]
            )
            require(
                task.id not in ids
                and fingerprint not in fingerprints
                and bundle["partition"] == partition,
                "task overlap or partition changed",
            )
            ids.add(task.id)
            fingerprints.add(fingerprint)
            families[partition].add(bundle["family"])
            scores = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            require(
                {key: value["reward"] for key, value in scores.items()}
                == {"reference": 1, "no_actions": 0, "missing_writes": 0},
                "authored task calibration changed",
            )
    require(
        all(
            not families[a] & families[b]
            for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
        ),
        "task families overlap",
    )
    with tempfile.TemporaryDirectory(prefix="gear-v6-fixed-pool-") as directory:
        pool = await build_pool(directory, source, search["pool_input"]["config"])
        require(
            pool == search["pool"] and read(Path(directory) / "input.json") == search["pool_input"],
            "fixed pool calibration or sampling changed",
        )
    require(
        search["pool_input"]["config"]
        == {
            "schema_version": 1,
            "partition": "train",
            **config["training"],
            "seed": "23/0",
            "generated": [],
            "fixed_count": 2,
            "generated_count": 0,
        }
        and search["input"]["pool_digest"] == digest(pool)
        and search["input"]["config"]
        == {
            "schema_version": 1,
            "pool_workspace": str(Path(search["workspace"]).parent / "pool"),
            **{
                key: config[key]
                for key in (
                    "validation",
                    "test",
                    "harness",
                    "model",
                    "meta_model",
                    "effort",
                    "max_steps",
                    "max_characters",
                    "target_characters",
                    "max_repairs",
                    "final_reply_on_limit",
                )
            },
            "max_calls": config["calls_per_search"],
        },
        "formal search consumed a different registered policy or pool",
    )
    records = {row["workspace"]: row for row in evidence["records"]}
    require(len(records) == len(evidence["records"]) == 5, "completed caller inventory differs")
    reports = [await verify_record(row, source) for row in records.values()]
    prefix = evidence["prefix"]
    prefix_report = await verify_prefix(prefix, source)
    require(
        all(row["status"] == "completed" and row["record"]["passed"] is False for row in reports),
        "original complete task outcomes changed",
    )
    require(len(search["sources"]) == 2, "source probe inventory changed")
    for row in search["sources"]:
        original = records[row["workspace"]]["files"]
        cfg, result = original["input.json"]["config"], original["result.json"]
        require(
            row["result_digest"] == digest(result)
            and row["observation"] == result["observation"]
            and any(
                all(
                    cfg[k] == bundle[k]
                    for k in ("partition", "family", "database", "user_id", "task", "reference")
                )
                for bundle in partitions["train"]
            )
            and all(
                cfg[k] == config[k]
                for k in ("harness", "model", "effort", "max_steps", "final_reply_on_limit")
            )
            and cfg["max_calls"] == config["calls_per_task"],
            "source collection differs from registered training inputs",
        )
    journal, benchmark = search["journal"], search["benchmark"]
    sealed(journal)
    sealed(benchmark)
    require(
        journal["status"] == "needs_recovery"
        and not journal["heldOutEvidence"]
        and journal["nomineeId"] is None
        and journal["specDigest"] == digest(journal["spec"])
        and journal["spec"]["benchmarkDigest"] == benchmark["digest"]
        and [row["request"]["operation"]["rationale"] for row in journal["operations"]]
        == ["baseline", "training", "propose", "candidate_training"],
        "interrupted formal lifecycle changed",
    )
    harnesses = {}
    for candidate, saved in zip(journal["candidates"], search["candidates"], strict=True):
        manifest = saved["manifest"]
        sealed(manifest)
        resource = next(row for row in manifest["resources"] if row["path"] == "AGENTS.md")
        require(
            candidate["digest"] == manifest["digest"]
            and saved["settings"] == {}
            and resource["digest"] == digest(base64.b64encode(saved["harness"].encode()).decode()),
            "candidate differs from sealed bytes",
        )
        harnesses[candidate["id"]] = saved["harness"]
    require(
        len(harnesses) == 2 and harnesses["anchor"] == config["harness"],
        "candidate inventory or baseline changed",
    )
    scopes = {
        partition: {
            row["gear_task_id"] for row in search["admission"] if row["partition"] == partition
        }
        for partition in partitions
    }
    admitted = []
    for partition, bundles in {
        "train": pool["selected"],
        "validation": config["validation"],
        "test": config["test"],
    }.items():
        for bundle in bundles:
            task = validate_task(bundle["task"], bundle["reference"])
            session = RetailSession(backend, bundle["database"], bundle["user_id"])
            fingerprint = digest(
                [
                    session.identity,
                    {
                        key: value
                        for key, value in task.model_dump(mode="json").items()
                        if key != "id"
                    },
                ]
            )
            identifier = "retail-" + digest([partition, task.id, fingerprint]).removeprefix(
                "sha256:"
            )
            bound = {**bundle, "gear_task_id": identifier}
            require(
                json.loads(benchmark["verifiers"][identifier]["expected"]) == bound,
                "admitted task differs from original pool or holdout",
            )
            admitted.append(
                {
                    "gear_task_id": identifier,
                    "native_task_id": task.id,
                    "partition": partition,
                    "bundle_digest": digest(bound),
                }
            )
    require(admitted == search["admission"], "formal admission changed")

    def bound_sample(record, request, slot):
        cfg = record["files"]["input.json"]["config"]
        bundle = json.loads(benchmark["verifiers"][slot["taskId"]]["expected"])
        require(
            all(
                cfg[k] == bundle[k]
                for k in ("partition", "family", "database", "user_id", "task", "reference")
            )
            and all(
                cfg[k] == config[k]
                for k in ("model", "effort", "max_steps", "final_reply_on_limit")
            )
            and cfg["harness"] == harnesses[request["operation"]["candidate_id"]]
            and cfg["max_calls"] == 34
            and cfg["sample_id"]
            == f"{request['runId']}/{request['operationId']}/{slot['taskId']}/{slot['repetition']}",
            "formal sample differs from admitted task and actual policy",
        )

    native, used_records, used_operations, proposals = {}, set(), set(), []
    meta = {row["request"]["key"]: row for row in search["meta_calls"]}
    require(len(meta) == 1, "Meta inventory changed")
    for operation in journal["operations"]:
        request = operation["request"]
        key = digest([request["runId"], request["operationId"]]).removeprefix("sha256:")
        if operation["status"] != "complete":
            require(
                operation["status"] == "submitted"
                and "receipt" not in operation
                and request["operation"]["rationale"] == "candidate_training"
                and key not in search["operations"]
                and set(request["operation"]["task_ids"]) == scopes["train"]
                and {(row["taskId"], row["repetition"]) for row in request["slots"]}
                == {(task, 0) for task in scopes["train"]},
                "interrupted operation acquired a receipt or changed scope",
            )
            bound_sample(prefix, request, request["slots"][0])
            continue
        used_operations.add(key)
        saved = search["operations"][key]
        receipt = saved["receipt"]
        projected = {
            **operation["receipt"],
            "evidence": [
                {k: v for k, v in row.items() if k != "raw_metrics"}
                for row in operation["receipt"]["evidence"]
            ],
        }
        require(
            saved["digest"] == digest(receipt) and projected == receipt,
            "formal receipt differs from provider result",
        )
        calls = {}
        if request.get("operatorCall"):
            require(
                set(request["operation"]["task_ids"]) == scopes["train"],
                "Meta escaped training scope",
            )
            job = prepare_jobs(
                {
                    "tasks": [
                        {k: task[k] for k in ("id", "family", "instruction")}
                        for task in benchmark["tasks"]
                    ]
                },
                request,
            )[0]
            original = meta[job["key"]]
            require(
                original["request"]
                == {
                    "key": job["key"],
                    "prompt": job["prompt"],
                    "harness": job["harness"],
                    "model": config["meta_model"],
                    "effort": config["effort"],
                    "output_schema": job["schema"],
                    "base_instructions": BASE_INSTRUCTIONS,
                    "tools": False,
                    "sdk": original["request"]["sdk"],
                }
                and original["receipt"]["status"] == "completed"
                and not original["receipt"].get("fixture", False),
                "Meta request or completion changed",
            )
            value = json.loads(original["receipt"]["response"])
            validate_output(job["schema"], value)
            require(
                receipt["result"]["data"] == {"declined": False, "data": value},
                "Meta output changed",
            )
            proposals.append(value["text"])
            calls[job["key"]] = original["receipt"]
        else:
            require(
                set(request["operation"]["task_ids"]) in (scopes["train"], scopes["validation"]),
                "evaluation escaped optimization scope",
            )
            for slot, sample, cell in zip(
                request["slots"], receipt["provenance"]["samples"], receipt["evidence"], strict=True
            ):
                original = records[sample["path"]]
                bound_sample(original, request, slot)
                result, trace = (
                    original["files"]["result.json"],
                    original["files"]["trajectory.json"],
                )
                record = result["observation"]["record"]
                require(
                    sample["result_digest"] == digest(result)
                    and sample["task_id"] == slot["taskId"]
                    and sample["partition"] == record["partition"],
                    "formal sample provenance differs",
                )
                require(
                    cell
                    == {
                        "candidate_id": request["operation"]["candidate_id"],
                        "task_id": slot["taskId"],
                        "repetition": slot["repetition"],
                        "scope": request["operation"]["scope"],
                        "status": "valid",
                        "score": int(record["passed"]),
                        "feedback": json.dumps(
                            {
                                "feedback": record["feedback"],
                                "steps": trace["steps"],
                                "complete": record["complete"],
                                "trajectory_digest": digest(trace),
                            }
                        ),
                    },
                    "formal score or feedback differs from actual execution",
                )
                contract = next(row for row in request["metrics"] if row["id"] == "pass_rate")
                candidate = next(
                    row for row in journal["candidates"] if row["id"] == cell["candidate_id"]
                )
                metric = {
                    "contractDigest": contract["digest"],
                    "unit": contract["unit"],
                    "status": "available",
                    "value": int(cell["score"] == 1),
                    "evidenceRefs": [
                        digest(
                            {
                                "benchmark": benchmark["digest"],
                                "provider": journal["spec"].get("evaluationIdentity")
                                or journal["spec"]["providerIdentity"],
                                "candidate": candidate["digest"],
                                "task": cell["task_id"],
                                "repetition": cell["repetition"],
                                "score": cell["score"],
                                "status": cell["status"],
                            }
                        )
                    ],
                }
                bound = next(
                    row
                    for row in operation["receipt"]["evidence"]
                    if (row["task_id"], row["repetition"]) == (cell["task_id"], cell["repetition"])
                )
                require(
                    bound["raw_metrics"] == {"pass_rate": metric},
                    "runtime metric projection differs",
                )
                calls.update(
                    {
                        row["request"]["key"]: row["receipt"]
                        for row in original["native_calls"].values()
                    }
                )
                used_records.add(sample["path"])
        require(
            sorted(calls) == receipt["provenance"]["call_keys"]
            and len(calls) == receipt["provenance"]["logical_model_calls"]
            and token_usage(list(calls.values())) == receipt["usage"]
            and not native.keys() & calls.keys(),
            "native operation accounting differs",
        )
        native.update(calls)
    require(
        used_operations == set(search["operations"])
        and used_records | {row["workspace"] for row in search["sources"]} == set(records),
        "unassigned formal record",
    )
    require(journal["physicalAttempts"] == 3, "unfinished candidate counted as a scored task")
    constraints = [
        row
        for decision in journal["operators"]["decisions"]
        for row in decision["decision"]["records"]
        if row["kind"] == "prompt_constraints"
    ]
    require(len(proposals) == len(constraints) == 1, "constraint inventory differs")
    verdict = PromptConstraints(config["max_characters"])(proposals[0])
    require(
        constraints[0]
        == {
            "kind": "prompt_constraints",
            "round": 0,
            "attempt": 0,
            "status": verdict.status,
            "reason": verdict.reason,
            "characters": len(proposals[0]),
        }
        and verdict.status == "allow"
        and len(proposals[0]) == 1640
        and proposals[0] == next(text for name, text in harnesses.items() if name != "anchor"),
        "candidate constraint decision or prompt changed",
    )
    all_receipts = (
        list(native.values())
        + [
            row["receipt"]
            for original in [records[row["workspace"]] for row in search["sources"]]
            for row in original["native_calls"].values()
        ]
        + [row["receipt"] for row in prefix["native_calls"].values()]
    )
    require(
        len(all_receipts) == 140 and all(row["usage"] is not None for row in all_receipts),
        "completed call inventory or usage differs",
    )
    known_tokens = token_usage(all_receipts)["tokens"]
    require(
        known_tokens == 3575238
        and evidence["accounting"]
        == {
            "submitted_turns": 141,
            "completed_turns": 140,
            "interrupted_turns": 1,
            "known_completed_native_tokens": known_tokens,
            "all_attempt_tokens": None,
            "weight_training_steps": 0,
            "availability_native_tokens_separate": 10617,
        },
        "interrupted call acquired invented usage or native cost changed",
    )
    stop = evidence["stop"]
    require(
        stop["process_exit_code"] == 1
        and stop["local_error"] == "TimeoutError"
        and stop["log"].rstrip().endswith("TimeoutError")
        and stop["inspection"] == prefix["inspection"]
        and stop["inspection"]["native_turn_status"] == "interrupted"
        and stop["inspection"]["error"] is None
        and stop["inspection"]["usage"] is None
        and stop["inspection"]["new_model_submissions"] == 0,
        "original timeout or read-only inspection changed",
    )
    require("openai_codex" not in sys.modules, "offline audit imported SDK")
    return {
        "status": "passed",
        "authored_tasks_calibrated": len(ids),
        "completed_task_records_replayed": len(reports),
        "completed_task_failures": 5,
        "interrupted_prefix": prefix_report,
        "formal_scored_slots": 3,
        "constraint_valid_candidates": 1,
        "known_completed_native_tokens": known_tokens,
        "all_attempt_tokens": None,
        "final_test_opened": False,
        "comparative_effect": None,
        "new_model_submissions": 0,
        "sdk_imported": False,
    }


async def audited(evidence, repository, source, negative_checks):
    report = await verify(evidence, repository, source)
    if negative_checks:
        rejected = []
        for name in ("candidate_prompt", "meta_input", "interrupted_request", "invented_score"):
            changed = copy.deepcopy(evidence)
            if name == "candidate_prompt":
                changed["search"]["candidates"][-1]["harness"] += " Altered."
            elif name == "meta_input":
                changed["search"]["meta_calls"][0]["request"]["prompt"] += " Altered."
            elif name == "interrupted_request":
                next(iter(changed["prefix"]["missing"].values()))["request"]["prompt"] += (
                    " Altered."
                )
            else:
                changed["prefix"]["files"]["result.json"] = {"status": "completed", "score": 0}
            try:
                await verify(changed, repository, source)
            except ValueError as error:
                rejected.append({"mutation": name, "rejected": True, "reason": str(error)})
            else:
                raise AssertionError("altered evidence accepted: " + name)
        report["negative_checks"] = rejected
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--negative-checks", action="store_true")
    args = parser.parse_args()
    sys.path[:0] = [
        str(args.repository / "python"),
        str(args.repository / "examples/curriculum-harness"),
    ]
    raw, manifest = (ARCHIVE / "evidence.json").read_bytes(), read(ARCHIVE / "manifest.json")
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "archive bytes changed")
    evidence = json.loads(raw)
    require(manifest["accounting"] == evidence["accounting"], "manifest accounting changed")
    print(
        json.dumps(
            asyncio.run(audited(evidence, args.repository, args.tau2_source, args.negative_checks)),
            indent=2,
        )
    )
