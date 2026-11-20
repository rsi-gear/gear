"""Replay V5 CPU records and check their rejected formal-runtime projection offline."""

import argparse
import asyncio
import base64
import copy
import hashlib
import json
import sys
from pathlib import Path

from records import read, require, verify_record


async def verify(evidence, repository, source):
    from formal_provider import prepare_jobs
    from gear.canonical import digest
    from gear.core.schema import validate_output
    from gear.search import PromptConstraints
    from model_calls import BASE_INSTRUCTIONS, token_usage
    from sentinel_generate import implementation_identity
    from sentinel_retail import RetailSession, calibrate, load_backend, validate_task

    def sealed(value):
        require(
            digest({k: v for k, v in value.items() if k != "digest"}) == value["digest"],
            "sealed artifact changed",
        )

    identity, protocol = evidence["study_identity"], evidence["protocol"]
    config, search = identity["config"], evidence["search"]
    journal, benchmark = search["journal"], search["benchmark"]
    require(
        evidence["source_commit"] == protocol["source_commit"] == "c032ab44a"
        and identity["implementation"] == implementation_identity()
        and digest(config) == protocol["config_digest"]
        and identity["model_calls"]["fixture"] is False
        and evidence["completed_study"] is False
        and evidence["final_test_opened"] is False
        and evidence["comparative_effect"] is None,
        "source, configuration or stopped study classification changed",
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
                **{k: config["training"][k] for k in ("family", "database", "user_id")},
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
                    {k: v for k, v in task.model_dump(mode="json").items() if k != "id"},
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
            calibrated = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            require(
                {k: v["reward"] for k, v in calibrated.items()}
                == {"reference": 1, "no_actions": 0, "missing_writes": 0},
                "reference calibration changed",
            )
    require(
        all(
            not families[a] & families[b]
            for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
        ),
        "task families overlap",
    )
    sealed(journal)
    sealed(benchmark)
    require(
        journal["specDigest"] == digest(journal["spec"])
        and journal["spec"]["benchmarkDigest"] == benchmark["digest"],
        "formal specification changed",
    )
    require(
        journal["status"] == "needs_recovery"
        and not journal["heldOutEvidence"]
        and journal["nomineeId"] is None,
        "interrupted formal run acquired a final selection",
    )
    harnesses = {}
    for candidate, saved in zip(journal["candidates"], search["candidates"], strict=True):
        manifest = saved["manifest"]
        sealed(manifest)
        require(
            manifest["digest"] == candidate["digest"] and saved["settings"] == {},
            "candidate identity changed",
        )
        resource = next(row for row in manifest["resources"] if row["path"] == "AGENTS.md")
        require(
            resource["digest"] == digest(base64.b64encode(saved["harness"].encode()).decode()),
            "candidate prompt differs from its sealed bytes",
        )
        harnesses[candidate["id"]] = saved["harness"]
    records = {record["workspace"]: record for record in evidence["records"]}
    require(len(records) == len(evidence["records"]) == 7, "caller inventory changed")
    reports = [await verify_record(record, source) for record in records.values()]
    for row in search["sources"]:
        original = records[row["workspace"]]["files"]["result.json"]
        cfg = records[row["workspace"]]["files"]["input.json"]["config"]
        require(
            row["result_digest"] == digest(original)
            and row["observation"] == original["observation"],
            "source record differs from its study input",
        )
        require(
            any(
                all(
                    cfg[k] == bundle[k]
                    for k in ("partition", "family", "database", "user_id", "task", "reference")
                )
                for bundle in partitions["train"]
            )
            and all(cfg[k] == config[k] for k in ("harness", "model", "effort", "max_steps"))
            and cfg["max_calls"] == config["calls_per_task"],
            "source probe differs from the registered training policy",
        )
    train = {row["gear_task_id"] for row in search["admission"] if row["partition"] == "train"}
    private = {row["gear_task_id"] for row in search["admission"] if row["partition"] != "train"}
    require(
        not train & private and search["input"]["pool_digest"] == digest(search["pool"]),
        "search admission changed",
    )
    meta = {row["request"]["key"]: row for row in search["meta_calls"]}
    used_meta, used_records, seen_calls = set(), set(), set()
    invalid_slots, accepted_slots, operation_receipts = [], [], []
    proposals = []
    for operation in journal["operations"]:
        request = operation["request"]
        key = digest([request["runId"], request["operationId"]]).removeprefix("sha256:")
        saved = search["operations"][key]
        receipt = saved["receipt"]
        require(saved["digest"] == digest(receipt), "provider receipt changed")
        if operation["status"] == "complete":
            projected = {
                **operation["receipt"],
                "evidence": [
                    {k: v for k, v in row.items() if k != "raw_metrics"}
                    for row in operation["receipt"]["evidence"]
                ],
            }
            require(projected == receipt, "formal journal differs from the provider receipt")
        else:
            require(
                operation["status"] == "submitted"
                and "receipt" not in operation
                and request["operation"]["rationale"] == "candidate_training",
                "unexpected unacknowledged operation",
            )
        calls = {}
        if request.get("operatorCall"):
            require(set(request["operation"]["task_ids"]) == train, "Meta accessed a private task")
            tasks = [
                {k: task[k] for k in ("id", "family", "instruction")} for task in benchmark["tasks"]
            ]
            job = prepare_jobs({"tasks": tasks}, request)[0]
            native = meta[job["key"]]
            expected = {
                "key": job["key"],
                "prompt": job["prompt"],
                "harness": job["harness"],
                "model": config["meta_model"],
                "effort": config["effort"],
                "output_schema": job["schema"],
                "base_instructions": BASE_INSTRUCTIONS,
                "tools": False,
                "sdk": native["request"]["sdk"],
            }
            require(
                native["request"] == expected
                and native["receipt"]["status"] == "completed"
                and not native["receipt"].get("fixture", False),
                "Meta response is not bound to its authorized input",
            )
            value = json.loads(native["receipt"]["response"])
            validate_output(job["schema"], value)
            require(
                receipt["result"]["data"] == {"declined": False, "data": value},
                "Meta proposal changed",
            )
            proposals.append(value["text"])
            calls[job["key"]] = native["receipt"]
            used_meta.add(job["key"])
        else:
            require(
                request["operation"]["kind"] == "evaluate_seed"
                and not set(request["operation"]["task_ids"])
                - {row["id"] for row in journal["spec"]["seedTasks"]},
                "formal evaluation escaped the optimization scope",
            )
            for slot, sample, cell in zip(
                request["slots"], receipt["provenance"]["samples"], receipt["evidence"], strict=True
            ):
                original = records[sample["path"]]
                files = original["files"]
                cfg, result, trace = (
                    files["input.json"]["config"],
                    files["result.json"],
                    files["trajectory.json"],
                )
                record = result["observation"]["record"]
                bundle = json.loads(benchmark["verifiers"][slot["taskId"]]["expected"])
                require(
                    sample["result_digest"] == digest(result)
                    and cfg["harness"] == harnesses[request["operation"]["candidate_id"]]
                    and all(
                        cfg[k] == bundle[k]
                        for k in ("partition", "family", "database", "user_id", "task", "reference")
                    ),
                    "formal slot differs from its executable caller record",
                )
                require(
                    sample["task_id"] == slot["taskId"] == cell["task_id"]
                    and cell["candidate_id"] == request["operation"]["candidate_id"]
                    and cell["scope"] == request["operation"]["scope"]
                    and cell["repetition"] == slot["repetition"]
                    and cfg["sample_id"]
                    == f"{request['runId']}/{request['operationId']}/{slot['taskId']}/{slot['repetition']}",
                    "formal logical sample changed",
                )
                require(
                    cell["score"] == (int(record["passed"]) if record["complete"] else None),
                    "unknown task acquired a score",
                )
                require(
                    json.loads(cell["feedback"])
                    == {
                        "feedback": record["feedback"],
                        "steps": trace["steps"],
                        "complete": record["complete"],
                        "trajectory_digest": digest(trace),
                    },
                    "formal feedback changed",
                )
                if cell["score"] is None:
                    require(
                        cell["status"] == "task_failed" and operation["status"] == "submitted",
                        "original incompatible projection changed",
                    )
                    invalid_slots.append(cfg["sample_id"])
                else:
                    require(
                        cell["status"] == "valid" and operation["status"] == "complete",
                        "valid formal result changed",
                    )
                    accepted_slots.append(cfg["sample_id"])
                    contract = next(
                        item for item in request["metrics"] if item["id"] == "pass_rate"
                    )
                    candidate = next(
                        item for item in journal["candidates"] if item["id"] == cell["candidate_id"]
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
                        item
                        for item in operation["receipt"]["evidence"]
                        if (item["task_id"], item["repetition"])
                        == (cell["task_id"], cell["repetition"])
                    )
                    require(
                        bound["raw_metrics"] == {"pass_rate": metric},
                        "runtime measurement projection differs",
                    )
                for native in original["native_calls"].values():
                    calls[native["request"]["key"]] = native["receipt"]
                used_records.add(sample["path"])
        require(
            sorted(calls) == receipt["provenance"]["call_keys"]
            and len(calls) == receipt["provenance"]["logical_model_calls"]
            and token_usage(list(calls.values())) == receipt["usage"],
            "operation usage differs from native receipts",
        )
        require(not seen_calls & calls.keys(), "native turn assigned to multiple operations")
        seen_calls.update(calls)
        operation_receipts.extend(calls.values())
    require(
        len(invalid_slots) == 2
        and len(accepted_slots) == journal["physicalAttempts"] == 3
        and used_meta == set(meta),
        "formal rejection or accounting changed",
    )
    require(
        used_records | {row["workspace"] for row in search["sources"]} == set(records),
        "unassigned caller record",
    )
    constraints = [
        row
        for decision in journal["operators"]["decisions"]
        for row in decision["decision"]["records"]
    ]
    require(len(proposals) == len(constraints) == 1, "proposal inventory changed")
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
        and proposals[0] == next(text for name, text in harnesses.items() if name != "anchor"),
        "candidate constraint decision changed",
    )
    source_records = [records[row["workspace"]] for row in search["sources"]]
    native = operation_receipts + [
        row["receipt"] for record in source_records for row in record["native_calls"].values()
    ]
    accounting = {
        "submitted_turns": len(native),
        "completed_turns": len(native),
        "native_tokens": token_usage(native)["tokens"],
        "weight_training_steps": 0,
    }
    require(
        accounting == evidence["accounting"] and len(native) == 221,
        "study cost attribution changed",
    )
    require(
        evidence["stop"]["exit_code"] == 1
        and evidence["stop"]["log"].rstrip().endswith(evidence["stop"]["message"]),
        "terminal process result changed",
    )
    return {
        "status": "passed",
        "authored_tasks_calibrated": len(ids),
        "caller_records_replayed": len(reports),
        "completed_tasks": sum(row["status"] == "completed" for row in reports),
        "incomplete_tasks": sum(row["status"] == "incomplete" for row in reports),
        "formal_scored_slots": len(accepted_slots),
        "rejected_unscored_slots": len(invalid_slots),
        **accounting,
        "final_test_opened": False,
        "new_model_submissions": 0,
        "sdk_imported": "openai_codex" in sys.modules,
    }


async def negative_checks(evidence, repository, source):
    from gear.canonical import digest

    results = []
    for name in ("candidate_prompt", "meta_input", "invented_score"):
        changed = copy.deepcopy(evidence)
        if name == "candidate_prompt":
            changed["search"]["candidates"][-1]["harness"] += " altered"
        elif name == "meta_input":
            changed["search"]["meta_calls"][0]["request"]["prompt"] += " altered"
        else:
            operation = next(
                row
                for row in changed["search"]["operations"].values()
                if any(cell["score"] is None for cell in row["receipt"]["evidence"])
            )
            operation["receipt"]["evidence"][0]["score"] = 0
            operation["digest"] = digest(operation["receipt"])
        try:
            await verify(changed, repository, source)
        except ValueError as error:
            results.append({"mutation": name, "rejected": True, "reason": str(error)})
        else:
            raise AssertionError("tampered evidence accepted: " + name)
    return results


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
    archive = Path(__file__).parent
    raw = (archive / "evidence.json").read_bytes()
    manifest = read(archive / "manifest.json")
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "archive bytes changed")
    evidence = json.loads(raw)
    require(manifest["accounting"] == evidence["accounting"], "manifest accounting changed")
    report = asyncio.run(verify(evidence, args.repository, args.tau2_source))
    if args.negative_checks:
        report["negative_checks"] = asyncio.run(
            negative_checks(evidence, args.repository, args.tau2_source)
        )
    print(json.dumps(report, indent=2))
