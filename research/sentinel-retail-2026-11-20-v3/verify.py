"""Replay exported retail execution traces, including unfinished prefixes, without an SDK."""

import argparse
import asyncio
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def rebase(value, original, destination):
    if isinstance(value, dict):
        return {key: rebase(item, original, destination) for key, item in value.items()}
    if isinstance(value, list):
        return [rebase(item, original, destination) for item in value]
    if isinstance(value, str) and value.startswith(original + "/"):
        return destination + value[len(original) :]
    return value


class MissingReceipt(Exception):
    pass


async def verify(archive, source, repository):
    sys.path[:0] = [str(repository / "python"), str(repository / "examples/curriculum-harness")]
    from gear.canonical import digest
    from sentinel_collect import RetailCollector
    from sentinel_generate import RetailGenerator
    from sentinel_retail import RetailSession, calibrate, load_backend, validate_task

    raw = (archive / "evidence.json").read_bytes()
    manifest = json.loads((archive / "manifest.json").read_text())
    if hashlib.sha256(raw).hexdigest() != manifest["evidence_sha256"]:
        raise ValueError("export digest changed")
    evidence = json.loads(raw)
    original = evidence["configs"]["original"]
    if digest(original) != evidence["protocol"]["config_digest"]:
        raise ValueError("preregistered task/model configuration changed")
    backend = load_backend(source)
    ids, content, families = set(), set(), {}
    calibrated = 0
    partitions = {
        "train": [
            {**{key: original["training"][key] for key in ("family", "database", "user_id")}, **row}
            for row in original["training"]["fixed"]
        ],
        "validation": original["validation"],
        "test": original["test"],
    }
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
            if (
                task.id in ids
                or fingerprint in content
                or (partition != "train" and bundle["partition"] != partition)
            ):
                raise ValueError("preregistered partitions overlap or changed")
            ids.add(task.id)
            content.add(fingerprint)
            families[partition].add(bundle["family"])
            scores = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            if {key: value["reward"] for key, value in scores.items()} != {
                "reference": 1,
                "no_actions": 0,
                "missing_writes": 0,
            }:
                raise ValueError("authored task calibration changed")
            calibrated += 1
    if any(
        families[a] & families[b]
        for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
    ):
        raise ValueError("private families overlap")
    counts = []
    receipts = []
    for record in evidence["records"]:
        expected = record["files"]
        identity = expected["input.json"]
        config = identity["config"]
        phase = Path(record["workspace"]).parents[1].name
        protocol = evidence["configs"][{"run": "original", "recovery-1": "recovery"}[phase]]
        if (
            record["kind"] != "collect"
            or config["partition"] != "train"
            or not any(
                all(
                    config[key] == bundle[key]
                    for key in ("task", "reference", "family", "database", "user_id")
                )
                for bundle in partitions["train"]
            )
            or any(
                config[key] != protocol[key] for key in ("harness", "model", "effort", "max_steps")
            )
            or config["max_calls"] != protocol["calls_per_task"]
        ):
            raise ValueError(
                "partial solver attempt is not bound to the predeclared normal training policy"
            )
        models = {
            name[6:-5]: value for name, value in expected.items() if name.startswith("model/")
        }
        if set(record["native_calls"]) != set(models):
            raise ValueError("caller transcripts differ from completed native turn inventory")
        seen = set()

        async def call(key, prompt, harness, **settings):
            if key not in models:
                pending = [
                    row["pending_request"]
                    for inspection in evidence["infrastructure"]
                    for row in inspection["requests"]
                    if row["pending"].startswith(str(identity["call_store"]) + "/")
                ]
                if len(pending) != 1 or any(
                    pending[0].get(name) != value
                    for name, value in {
                        "key": key,
                        "prompt": prompt,
                        "harness": harness,
                        **settings,
                    }.items()
                ):
                    raise ValueError(
                        "unfinished replay does not match the original submitted request"
                    )
                raise MissingReceipt(key)
            saved = models[key]
            prepared = saved["input"]
            if (
                json.loads(prompt) != prepared["data"]
                or harness != prepared["prompt"]
                or settings
                != {
                    "model": config["model"],
                    "effort": config["effort"],
                    "output_schema": prepared["schema"],
                }
                or saved["receipt"]["status"] != "completed"
            ):
                raise ValueError("saved request or response differs: " + key)
            native = record["native_calls"][key]
            if native["receipt"] != saved["receipt"] or any(
                native["request"].get(name) != value
                for name, value in {
                    "key": key,
                    "prompt": prompt,
                    "harness": harness,
                    **settings,
                }.items()
            ):
                raise ValueError("native receipt or request differs from the caller transcript")
            seen.add(key)
            return saved["receipt"]

        calls = SimpleNamespace(
            call=call,
            max_calls=config["max_calls"],
            identity=identity["model_calls_identity"],
            timeout_seconds=identity["call_timeout_seconds"],
        )
        if identity["call_store"] is not None:
            calls.root = Path(identity["call_store"])
        missing = None
        with tempfile.TemporaryDirectory(prefix="gear-retail-comparison-replay-") as directory:
            cls = RetailCollector if record["kind"] == "collect" else RetailGenerator
            caller = cls(directory, source, config, calls)
            if caller.identity != identity:
                raise ValueError("frozen source, model or native runtime changed")
            try:
                await (caller.collect() if record["kind"] == "collect" else caller.generate())
            except MissingReceipt as error:
                missing = str(error)
            if (missing is not None) != ("result.json" not in expected):
                raise ValueError("complete versus unfinished execution classification changed")
            actual = {
                path.relative_to(directory).as_posix(): rebase(
                    json.loads(path.read_text()),
                    str(Path(directory).resolve()),
                    record["workspace"],
                )
                for path in Path(directory).rglob("*.json")
            }
            if actual != expected or seen != set(models):
                raise ValueError("replayed files or response inventory differ")
        counts.append(
            {
                "workspace": record["workspace"],
                "completed_responses": len(seen),
                "awaited_key": missing,
                "result_digest": digest(expected["result.json"])
                if "result.json" in expected
                else None,
            }
        )
        receipts.extend(row["receipt"] for row in record["native_calls"].values())
    if evidence.get("recovery"):
        original = evidence["configs"]["original"]
        recovered = evidence["configs"]["recovery"]
        consumed = evidence["recovery"]["original_submitted_turns"]
        if recovered != {**original, "calls_per_task": original["calls_per_task"] - consumed}:
            raise ValueError("recovery changed more than the remaining task quota")
    for inspection in evidence["infrastructure"]:
        if inspection["new_submissions"] != 0 or any(
            row["new_submissions"] != 0 or row["terminal_status"] not in ("failed", "interrupted")
            for row in inspection["requests"]
        ):
            raise ValueError("infrastructure stop did not retain a known terminal failure")
    pending = [row for inspection in evidence["infrastructure"] for row in inspection["requests"]]
    if (
        [row["terminal_status"] for row in pending] != ["failed", "interrupted"]
        or any(row["result_digest"] is not None for row in counts)
        or evidence["completed_study"] is not None
    ):
        raise ValueError(
            "this archive must preserve the two interrupted attempts without an effect result"
        )
    if evidence["accounting"] != {
        "submitted_turns": len(receipts) + len(pending),
        "saved_completed_turns": len(receipts),
        "known_completed_tokens": sum(row["usage"]["total"]["total_tokens"] for row in receipts),
        "all_attempt_tokens": None,
    }:
        raise ValueError("native accounting changed or missing usage was inferred")
    return {
        "status": "passed",
        "authored_tasks_calibrated": calibrated,
        "records": counts,
        "new_model_submissions": 0,
        "sdk_imported": "openai_codex" in sys.modules,
        "scope": "Actual collection/generation traces and incomplete prefixes; no comparison claim without a completed study.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            asyncio.run(verify(Path(__file__).resolve().parent, args.tau2_source, args.repository)),
            indent=2,
        )
    )
