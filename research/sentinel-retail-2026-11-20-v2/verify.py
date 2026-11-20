"""Re-execute the exported solver, generation, memory and pool probe without an SDK."""

import argparse
import asyncio
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))

import sentinel_pool  # noqa: E402
from gear.canonical import digest  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import RetailGenerator  # noqa: E402


def rebase(value, source, destination):
    """Only evidence workspace paths vary in an independent replay."""
    if isinstance(value, dict):
        return {key: rebase(item, source, destination) for key, item in value.items()}
    if isinstance(value, list):
        return [rebase(item, source, destination) for item in value]
    if isinstance(value, str) and value.startswith(source + "/"):
        return destination + value[len(source) :]
    return value


def recorded_calls(record):
    identity = record["files"]["input.json"]
    config = identity["config"]
    records = {
        key[len("model/") : -len(".json")]: value
        for key, value in record["files"].items()
        if key.startswith("model/")
    }
    seen = set()

    async def call(key, prompt, harness, **settings):
        saved = records[key]
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
        ):
            raise ValueError("recorded model input changed: " + key)
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
    return calls, records, seen


async def verify_record(record, source, kind):
    calls, records, seen = recorded_calls(record)
    expected = record["files"]
    with tempfile.TemporaryDirectory(prefix="gear-sentinel-v2-replay-") as directory:
        cls = RetailCollector if kind == "collect" else RetailGenerator
        caller = cls(directory, source, expected["input.json"]["config"], calls)
        if caller.identity != expected["input.json"]:
            raise ValueError("source, runtime or frozen inputs differ")
        await (caller.collect() if kind == "collect" else caller.generate())
        actual = {
            path.relative_to(directory).as_posix(): rebase(
                json.loads(path.read_text()), str(Path(directory).resolve()), record["workspace"]
            )
            for path in Path(directory).rglob("*.json")
        }
        if actual != expected or seen != set(records):
            differences = sorted(
                key for key in set(actual) | set(expected) if actual.get(key) != expected.get(key)
            )
            raise ValueError("replayed files or consumed model records differ: " + str(differences))
    return len(seen)


async def verify(archive, source):
    manifest = json.loads((archive / "manifest.json").read_text())
    raw = (archive / "evidence.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["evidence_sha256"]:
        raise ValueError("export bytes differ from manifest")
    evidence = json.loads(raw)
    runs = evidence["runs"]
    failures = evidence["infrastructure_failures"]
    if any(
        item["terminal_status"] != "failed" or item["new_submissions_during_inspection"] != 0
        for item in failures
    ):
        raise ValueError("infrastructure recovery did not start from a known terminal failure")
    counts = {}
    for name in ("baseline", "stop-control"):
        counts[name] = await verify_record(runs[name], source, "collect")
    control = runs["stop-control"]["files"]["result.json"]["observation"]
    if "generation" in runs:
        if control["record"]["passed"] is not False or not control["record"]["complete"]:
            raise ValueError("generator source was not an actual completed failure")
        generation = runs["generation"]
        original = failures[0]["input"]["config"]
        recovered = generation["files"]["input.json"]["config"]
        if recovered != {**original, "max_calls": original["max_calls"] - 1}:
            raise ValueError("recovery changed more than the remaining call allowance")
        if generation["files"]["input.json"]["config"]["observations"] != [control]:
            raise ValueError("generation source differs from the replayed solver failure")
        counts["generation"] = await verify_record(generation, source, "generate")
    if "carry" in runs:
        config = runs["carry"]["files"]["input.json"]["config"]
        if config["history"] != generation["files"]["memory.json"] or config["observations"] != [
            control
        ]:
            raise ValueError("memory was not carried from the verified prior round")
        counts["carry"] = await verify_record(runs["carry"], source, "generate")
    if "pool" in evidence:
        pool = evidence["pool"]
        pool_config = pool["files"]["input.json"]["config"]
        if (
            pool_config["fixed"][0]["task"]
            != runs["stop-control"]["files"]["input.json"]["config"]["task"]
        ):
            raise ValueError("fixed pool task changed from the frozen source task")
        result = generation["files"]["result.json"]
        if result["status"] == "rejected":
            exclusions = [
                {
                    "workspace": generation["workspace"],
                    "result_digest": digest(result),
                    "reason": "Generated candidate failed the frozen validation policy.",
                }
            ]
            if pool_config["generated"] or evidence["pool_exclusions"] != exclusions:
                raise ValueError("rejected generation was admitted or its exclusion changed")
        original_replay = sentinel_pool.replay_generated
        with tempfile.TemporaryDirectory(prefix="gear-sentinel-v2-pool-") as directory:
            materialized = Path(directory) / "generation"
            for name, value in generation["files"].items():
                path = materialized / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value))

            async def replay_from_export(path, source_root):
                if str(Path(path).resolve()) != generation["workspace"]:
                    raise ValueError("pool requested an unexported generation")
                bundle = await original_replay(materialized, source_root)
                bundle["provenance"]["workspace"] = generation["workspace"]
                return bundle

            with patch.object(sentinel_pool, "replay_generated", replay_from_export):
                await sentinel_pool.build_pool(
                    Path(directory) / "pool", source, pool["files"]["input.json"]["config"]
                )
            actual = {
                path.name: json.loads(path.read_text())
                for path in (Path(directory) / "pool").glob("*.json")
            }
            if actual != pool["files"]:
                raise ValueError("mixed pool source, validation or selection differs")
    return {
        "status": "passed",
        "unique_completed_model_receipts_verified": counts,
        "new_model_submissions": 0,
        "retained_infrastructure_failures": len(failures),
        "actual_tools_and_native_grading_reexecuted": True,
        "result_digests": {
            name: digest(record["files"]["result.json"]) for name, record in runs.items()
        },
        "pool_digest": digest(evidence["pool"]["files"]["result.json"])
        if "pool" in evidence
        else None,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tau2-source", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(asyncio.run(verify(Path(__file__).resolve().parent, args.tau2_source)), indent=2)
    )
