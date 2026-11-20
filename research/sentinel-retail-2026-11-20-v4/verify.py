"""Replay the V4 model-contract rejection and native tools; never submit a turn."""

import argparse
import asyncio
import copy
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def require(condition, message):
    if not condition:
        raise ValueError(message)


def rebase(value, original, destination):
    if isinstance(value, dict):
        return {key: rebase(item, original, destination) for key, item in value.items()}
    if isinstance(value, list):
        return [rebase(item, original, destination) for item in value]
    if isinstance(value, str) and value.startswith(original + "/"):
        return destination + value[len(original) :]
    return value


async def verify(archive, repository, source):
    sys.path[:0] = [str(repository / "python"), str(repository / "examples/curriculum-harness")]
    from gear.canonical import digest
    from sentinel_collect import RetailCollector
    from sentinel_generate import implementation_identity
    from sentinel_retail import RetailSession, calibrate, load_backend, validate_task

    manifest = json.loads((archive / "manifest.json").read_text())
    raw = (archive / "evidence.json").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == manifest["evidence_sha256"], "export bytes changed")
    evidence = json.loads(raw)
    require(
        evidence["source_commit"]
        == manifest["source_commit"]
        == evidence["protocol"]["source_commit"]
        == "52d720227"
        and manifest["completed_study"] is False
        and evidence["stop"]
        == {
            "exit_code": 1,
            "exception": "ValueError",
            "message": "reference messages require text and no tool arguments",
            "model_key": "solve/22",
            "native_turn_status": "completed",
            "task_result": None,
            "new_submissions_after_stop": 0,
        },
        "source version or stopped execution classification changed",
    )
    config = evidence["study_identity"]["config"]
    require(
        digest(config)
        == evidence["protocol"]["config_digest"]
        == "sha256:5899f7e4c60033bbbb5fedef33fb65297b0b67f2378b9dfd7e2c709d959bf133"
        and evidence["study_identity"]["implementation"] == implementation_identity()
        and evidence["study_identity"]["model_calls"]["fixture"] is False,
        "study configuration or frozen implementation changed",
    )
    backend = load_backend(source)
    require(backend["identity"] == evidence["study_identity"]["backend"], "native backend changed")
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
    identifiers, fingerprints, families = set(), set(), {}
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
                task.id not in identifiers
                and fingerprint not in fingerprints
                and bundle["partition"] == partition,
                "authored partition or content overlap",
            )
            identifiers.add(task.id)
            fingerprints.add(fingerprint)
            families[partition].add(bundle["family"])
            result = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            require(
                {key: row["reward"] for key, row in result.items()}
                == {"reference": 1, "no_actions": 0, "missing_writes": 0},
                "authored reference or negative calibration changed",
            )
    require(
        all(
            not families[a] & families[b]
            for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
        ),
        "private task families overlap",
    )
    record = evidence["record"]
    expected = record["files"]
    identity = expected["input.json"]
    sample = identity["config"]
    require(
        any(
            all(
                sample[k] == bundle[k]
                for k in ("partition", "family", "database", "user_id", "task", "reference")
            )
            for bundle in partitions["train"]
        )
        and all(sample[k] == config[k] for k in ("model", "effort", "harness", "max_steps"))
        and sample["max_calls"] == config["calls_per_task"],
        "source sample differs from the registered normal policy",
    )
    models = {name[6:-5]: value for name, value in expected.items() if name.startswith("model/")}
    native = record["native_calls"]
    require(set(models) == set(native) and len(native) == 43, "native call inventory differs")
    seen = []

    async def call(key, prompt, harness, **settings):
        require(key in models, "missing saved model response")
        saved = models[key]
        prepared = saved["input"]
        request = native[key]["result"]["request"]
        receipt = native[key]["result"]["receipt"]
        require(
            request == native[key]["pending"]["request"]
            and receipt == saved["receipt"]
            and receipt["status"] == "completed"
            and all(
                request.get(k) == v
                for k, v in {"key": key, "prompt": prompt, "harness": harness, **settings}.items()
            )
            and json.loads(prompt) == prepared["data"]
            and harness == prepared["prompt"]
            and settings
            == {
                "model": sample["model"],
                "effort": sample["effort"],
                "output_schema": prepared["schema"],
            },
            "native request or response differs from the caller transcript",
        )
        seen.append(key)
        return receipt

    calls = SimpleNamespace(
        call=call,
        max_calls=sample["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
        root=Path(identity["call_store"]),
    )
    with tempfile.TemporaryDirectory(prefix="gear-retail-v4-replay-") as directory:
        collector = RetailCollector(directory, source, sample, calls)
        require(collector.identity == identity, "collector runtime changed")
        try:
            await collector.collect()
        except ValueError as error:
            require(str(error) == evidence["stop"]["message"], "stop reason changed")
        else:
            raise ValueError("invalid final reply was accepted")
        actual = {
            path.relative_to(directory).as_posix(): rebase(
                json.loads(path.read_text()), str(Path(directory).resolve()), record["workspace"]
            )
            for path in Path(directory).rglob("*.json")
        }
        require(actual == expected, "native replay or checkpoint evidence changed")
    require(
        set(seen) == set(models)
        and len(seen) == len(models)
        and seen[-1] == evidence["stop"]["model_key"] == "solve/22"
        and "result.json" not in expected
        and "steps/22.json" not in expected
        and evidence["completed_study"] is None,
        "invalid output acquired a task result or extra execution",
    )
    tokens = sum(
        row["result"]["receipt"]["usage"]["total"]["total_tokens"] for row in native.values()
    )
    require(
        evidence["accounting"]
        == manifest["accounting"]
        == {
            "submitted_turns": 43,
            "completed_turns": 43,
            "native_tokens": 990092,
            "weight_training_steps": 0,
            "separate_availability_probe_tokens": 9224,
        }
        and tokens == 990092,
        "native accounting changed",
    )
    return {
        "status": "passed",
        "authored_tasks_calibrated": len(identifiers),
        "completed_model_receipts": len(seen),
        "native_tokens": tokens,
        "executed_prefix_steps": len([name for name in expected if name.startswith("steps/")]),
        "reproduced_stop": evidence["stop"]["message"],
        "task_score": None,
        "new_model_submissions": 0,
        "sdk_imported": "openai_codex" in sys.modules,
    }


async def negative_checks(archive, repository, source):
    original = json.loads((archive / "evidence.json").read_text())
    checks = []
    for name in (
        "native_response",
        "pending_request",
        "invented_task_score",
        "native_usage",
        "tool_result",
    ):
        evidence = copy.deepcopy(original)
        record = evidence["record"]
        native = record["native_calls"]["solve/1"]
        if name == "native_response":
            native["result"]["receipt"]["response"] = "{}"
        elif name == "pending_request":
            native["pending"]["request"]["prompt"] = "changed input"
        elif name == "invented_task_score":
            record["files"]["result.json"] = {"status": "completed", "passed": False}
        elif name == "native_usage":
            native["result"]["receipt"]["usage"]["total"]["total_tokens"] += 1
            record["files"]["model/solve/1.json"]["receipt"] = native["result"]["receipt"]
        else:
            record["files"]["steps/1.json"]["execution"]["response"]["content"] = "forged customer"
        with tempfile.TemporaryDirectory(prefix="gear-retail-v4-negative-") as directory:
            root = Path(directory)
            raw = json.dumps(evidence).encode()
            manifest = json.loads((archive / "manifest.json").read_text())
            manifest["evidence_sha256"] = hashlib.sha256(raw).hexdigest()
            (root / "evidence.json").write_bytes(raw)
            (root / "manifest.json").write_text(json.dumps(manifest))
            try:
                await verify(root, repository, source)
            except ValueError as error:
                checks.append({"change": name, "rejected": True, "reason": str(error)})
            else:
                raise ValueError("tampered evidence was accepted: " + name)
    return {"checks": checks, "new_model_submissions": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--negative-checks", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            asyncio.run(
                (negative_checks if args.negative_checks else verify)(
                    Path(__file__).parent, args.repository, args.tau2_source
                )
            ),
            indent=2,
        )
    )
