"""Replay V8's two completed sources and failed generation prefix without an SDK."""

import argparse
import asyncio
import copy
import hashlib
import json
import sys
from pathlib import Path

from prefix import verify_prefix
from records import read, require, verify_record

ARCHIVE = Path(__file__).resolve().parent


async def verify(evidence, repository, source):
    from gear.canonical import digest
    from gear.core import DeterministicRandom
    from sentinel_experiment import validate_config
    from sentinel_generate import implementation_identity
    from sentinel_retail import RetailSession, calibrate, load_backend, validate_task

    identity, protocol = evidence["study_identity"], evidence["protocol"]
    config = validate_config(identity["config"])
    require(
        config == read(ARCHIVE / "config.json")
        and protocol == read(ARCHIVE / "protocol.json")
        and digest(config) == protocol["config_digest"]
        and protocol["source_commit"] == "70895c019a79726a65f1d14ccc7af0adb1f3a993"
        and identity["implementation"] == implementation_identity()
        and identity["model_calls"]["fixture"] is False
        and config["call_timeout_seconds"] == 600
        and config["call_delay_seconds"] == 10
        and evidence["completed_study"] is False
        and evidence["final_test_opened"] is False
        and evidence["comparative_effect"] is None,
        "source, configuration or stopped classification differs",
    )
    for name, expected in identity["search_implementation"].items():
        require(
            hashlib.sha256((repository / name).read_bytes()).hexdigest() == expected,
            "search implementation changed",
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
            scores = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            require(
                {k: v["reward"] for k, v in scores.items()}
                == {"reference": 1, "no_actions": 0, "missing_writes": 0},
                "authored calibration changed",
            )
    require(
        all(
            not families[a] & families[b]
            for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
        ),
        "family isolation changed",
    )
    seed = config["seeds"][0]
    rng = DeterministicRandom(str(seed))
    require(
        config["seeds"] == [1]
        and config["rounds"] == 1
        and sorted(
            ("random", "fixed", "failure"), key=lambda arm: (rng.value("arm-order-" + arm, 0), arm)
        )
        == protocol["arm_order"],
        "registered ordering changed",
    )
    records = {row["workspace"]: row for row in evidence["records"]}
    require(
        len(records) == len(evidence["sources"]) == len(partitions["train"]) == 2,
        "source inventory differs",
    )
    reports = []
    for row, bundle in zip(evidence["sources"], partitions["train"], strict=True):
        original = records[row["workspace"]]
        actual = original["files"]["result.json"]
        key = digest([str(seed), 0, bundle, config["harness"]]).removeprefix("sha256:")
        require(
            original["kind"] == "collect"
            and row["workspace"] == evidence["workspace"] + "/observations/" + key
            and row["result_digest"] == digest(actual)
            and row["observation"] == actual["observation"]
            and original["files"]["input.json"]["call_timeout_seconds"]
            == config["call_timeout_seconds"]
            and original["files"]["input.json"]["call_delay_seconds"]
            == config["call_delay_seconds"]
            and original["files"]["input.json"]["config"]
            == {
                "schema_version": 1,
                **{
                    k: bundle[k]
                    for k in ("partition", "family", "database", "user_id", "task", "reference")
                },
                **{
                    k: config[k]
                    for k in ("model", "effort", "harness", "max_steps", "final_reply_on_limit")
                },
                "max_calls": config["calls_per_task"],
                "sample_id": key,
                "attempt": 0,
            },
            "source differs from its registered training task or policy",
        )
        reports.append(await verify_record(original, source))
    prefix = evidence["prefix"]
    root = (
        evidence["workspace"]
        + "/trials/"
        + digest(str(seed)).removeprefix("sha256:")
        + "/random/0/generation/0"
    )
    require(
        prefix["workspace"] == root
        and prefix["files"]["input.json"]["call_timeout_seconds"] == config["call_timeout_seconds"]
        and prefix["files"]["input.json"]["call_delay_seconds"] == config["call_delay_seconds"]
        and prefix["files"]["input.json"]["config"]
        == {
            "schema_version": 1,
            "partition": "train",
            **{k: config["training"][k] for k in ("family", "database", "user_id")},
            **{
                k: config[k]
                for k in ("effort", "max_steps", "final_reply_on_limit", "random_targets")
            },
            "model": config["generator_model"],
            "max_calls": config["calls_per_generation"],
            "max_cases": 128,
            "seed": "1/0/0",
            "conditioning": "random",
            "observations": [],
        },
        "random generator received different settings or failure/private material",
    )
    prefix_report = await verify_prefix(prefix, source)
    inspection = evidence["stop"]["inspection"]
    require(
        evidence["stop"]["process_exit_code"] == 1
        and evidence["stop"]["log"]
        .rstrip()
        .endswith("RuntimeError: exceeded retry limit, last status: 429 Too Many Requests")
        and inspection == prefix["inspection"]
        and inspection["key"] == "explore/5"
        and inspection["error"]["codex_error_info"]
        == {"response_too_many_failed_attempts": {"http_status_code": 429}},
        "original terminal 429 classification changed",
    )
    native = [
        row["receipt"]
        for record in [*records.values(), prefix]
        for row in record["native_calls"].values()
    ]
    require(
        len(native) == 71 and all(row["usage"] is not None for row in native),
        "native completion accounting differs",
    )
    tokens = sum(row["usage"]["total"]["total_tokens"] for row in native)
    accounting = {
        "submitted_turns": 72,
        "completed_turns": 71,
        "failed_turns": 1,
        "known_completed_native_tokens": tokens,
        "all_attempt_tokens": None,
        "weight_training_steps": 0,
        "availability_calls_separate": 1,
        "availability_native_tokens_separate": 9137,
    }
    require(
        evidence["accounting"] == accounting
        and tokens == 2064712
        and "openai_codex" not in sys.modules,
        "usage or offline fixed-weight contract differs",
    )
    return {
        "status": "passed",
        "authored_tasks_calibrated": len(ids),
        "completed_sources_replayed": len(reports),
        "source_failures": sum(row["record"]["passed"] is False for row in reports),
        "failed_generation_prefix": prefix_report,
        "accounting": accounting,
        "final_test_opened": False,
        "comparative_effect": None,
        "new_model_submissions": 0,
        "sdk_imported": False,
    }


async def audited(evidence, repository, source, negative_checks):
    report = await verify(evidence, repository, source)
    if negative_checks:
        rejected = []
        for name in (
            "failed_request",
            "tool_result",
            "invented_generation_result",
            "source_score",
            "wait_budget",
            "submission_delay",
        ):
            changed = copy.deepcopy(evidence)
            if name == "failed_request":
                next(iter(changed["prefix"]["missing"].values()))["request"]["prompt"] += (
                    " Altered."
                )
            elif name == "tool_result":
                step = next(
                    v
                    for k, v in changed["prefix"]["files"].items()
                    if k.startswith("steps/") and v["kind"] == "tool"
                )
                step["execution"]["response"]["content"] = "invented tool result"
            elif name == "invented_generation_result":
                changed["prefix"]["files"]["result.json"] = {
                    "status": "ready",
                    "selected": ["invented"],
                }
            elif name == "source_score":
                changed["records"][0]["files"]["result.json"]["observation"]["record"]["passed"] = (
                    True
                )
            elif name == "wait_budget":
                changed["prefix"]["files"]["input.json"]["call_timeout_seconds"] += 1
            else:
                changed["prefix"]["files"]["input.json"]["call_delay_seconds"] += 1
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
    raw = (ARCHIVE / "evidence.json").read_bytes()
    manifest = read(ARCHIVE / "manifest.json")
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "archive bytes changed")
    evidence = json.loads(raw)
    require(
        manifest["accounting"] == evidence["accounting"]
        and manifest["config_digest"] == evidence["protocol"]["config_digest"],
        "manifest differs",
    )
    print(
        json.dumps(
            asyncio.run(audited(evidence, args.repository, args.tau2_source, args.negative_checks)),
            indent=2,
        )
    )
