"""Replay generated retail tasks and seal an explicit fixed/generated search pool.

This caller does not admit tasks into a running search or start model requests.
Generated candidates must reproduce their complete validation from saved responses.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from gear.canonical import digest
from gear.core import DeterministicRandom
from ifeval_experiment import read_json
from sentinel_generate import RetailGenerator, freeze, implementation_identity
from sentinel_retail import RetailSession, calibrate, load_backend, validate_task


async def replay_generated(root, source_root):
    """Read-only model receipts, with no SDK client or fallback submission path."""
    root = Path(root).resolve()
    identity = read_json(root / "input.json")
    config = identity["config"]
    records = {
        path.relative_to(root / "model").with_suffix("").as_posix(): read_json(path)
        for path in (root / "model").rglob("*.json")
    }
    seen = set()

    async def saved_response(key, prompt, harness, **settings):
        if key not in records:
            raise ValueError("missing completed generation response: " + key)
        prepared, receipt = records[key]["input"], records[key]["receipt"]
        if (
            json.loads(prompt) != prepared["data"]
            or harness != prepared["prompt"]
            or settings
            != {
                "model": config["model"],
                "effort": config["effort"],
                "output_schema": prepared["schema"],
            }
            or receipt.get("status") != "completed"
        ):
            raise ValueError("saved generation request or response changed: " + key)
        seen.add(key)
        return receipt

    calls = SimpleNamespace(
        call=saved_response,
        max_calls=config["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
    )
    if identity["call_store"] is not None:
        calls.root = Path(identity["call_store"])
    with tempfile.TemporaryDirectory(prefix="gear-sentinel-pool-check-") as directory:
        generator = RetailGenerator(directory, source_root, config, calls)
        if generator.identity != identity:
            raise ValueError("generated task runtime or source differs; replay its frozen version")
        result = await generator.generate()
        if result != read_json(root / "result.json") or seen != set(records):
            raise ValueError("generated result or model receipt inventory changed")
        if result["status"] != "ready" or result["selected"] != [result["draft"]["draft_id"]]:
            raise ValueError("generated task did not pass its full validation policy")
        for name in ("reference", "calibration", "validation-evidence", "memory"):
            if read_json(Path(directory) / (name + ".json")) != read_json(root / (name + ".json")):
                raise ValueError("generated validation evidence changed: " + name)
    return {
        "partition": config["partition"],
        "family": config["family"],
        "database": config["database"],
        "user_id": config["user_id"],
        "task": result["task"],
        "reference": read_json(root / "reference.json"),
        "provenance": {
            "kind": "generated",
            "workspace": str(root),
            "input_digest": digest(identity),
            "result_digest": digest(result),
        },
    }


async def build_pool(root, source_root, config):
    """Exact quotas, without replacement or silent fallback when a source is short."""
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return await _build_pool(root, source_root, config)


async def _build_pool(root, source_root, config):
    expected = {
        "schema_version",
        "partition",
        "family",
        "database",
        "user_id",
        "fixed",
        "generated",
        "fixed_count",
        "generated_count",
        "seed",
    }
    if (
        set(config) != expected
        or type(config["schema_version"]) is not int
        or config["schema_version"] != 1
        or config["partition"] != "train"
    ):
        raise ValueError("mixed pool requires an explicit training scope")
    if not isinstance(config["family"], str) or not config["family"].strip():
        raise ValueError("mixed pool family must be nonempty")
    if (
        any(
            type(config[key]) is not int or not 0 <= config[key] <= 128
            for key in ("fixed_count", "generated_count")
        )
        or not config["fixed_count"] + config["generated_count"]
    ):
        raise ValueError("mixed pool requires bounded explicit source counts")
    if type(config["seed"]) not in (int, str) or not str(config["seed"]).strip():
        raise ValueError("mixed pool requires an explicit seed")
    if any(
        not isinstance(config[key], list) or len(config[key]) > 128
        for key in ("fixed", "generated")
    ):
        raise ValueError("mixed pool source inventories must be bounded lists")
    config = json.loads(json.dumps(config, allow_nan=False))
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    backend = load_backend(source_root)
    session = RetailSession(backend, config["database"], config["user_id"])
    freeze(
        root / "input.json",
        {
            "config": config,
            "backend": backend["identity"],
            "implementation": implementation_identity(),
        },
    )
    sources = {"fixed": [], "generated": []}
    for row in config["fixed"]:
        if set(row) != {"task", "reference", "evidence_refs"} or not row["evidence_refs"]:
            raise ValueError("fixed tasks require caller-authenticated source evidence")
        sources["fixed"].append(
            {
                **{key: config[key] for key in ("partition", "family", "database", "user_id")},
                "task": row["task"],
                "reference": row["reference"],
                "provenance": {
                    "kind": "fixed",
                    "digest": digest(row),
                    "evidence_refs": row["evidence_refs"],
                },
            }
        )
    for entry in config["generated"]:
        if isinstance(entry, dict):
            if set(entry) != {"recipe", "workspace", "draft_id"} or entry["recipe"] != "coevolve":
                raise ValueError("unsupported generated retail recipe")
            # Direct conversion at the caller boundary; no curriculum adapter.
            from coevolve_retail import replay_generated as replay_coevolve

            sources["generated"].append(
                await replay_coevolve(entry["workspace"], source_root, entry["draft_id"])
            )
        else:
            sources["generated"].append(await replay_generated(entry, source_root))
    rng = DeterministicRandom(str(config["seed"]))
    content_ids, task_ids = set(), set()
    for kind, bundles in sources.items():
        for bundle in bundles:
            if (
                bundle["partition"] != "train"
                or bundle["family"] != config["family"]
                or RetailSession(backend, bundle["database"], bundle["user_id"]).identity
                != session.identity
            ):
                raise ValueError("pool task belongs to another training scope")
            task = validate_task(bundle["task"], bundle["reference"])
            calibration = calibrate(
                backend, bundle["database"], bundle["user_id"], bundle["reference"], task
            )
            content_id = digest(
                [session.identity, task.ticket.strip(), task.user_scenario.model_dump(mode="json")]
            )
            if content_id in content_ids or task.id in task_ids:
                raise ValueError("duplicate task or content across mixed pool sources")
            content_ids.add(content_id)
            task_ids.add(task.id)
            bundle["pool_task_id"] = content_id
            bundle["calibration_digest"] = digest(calibration)
        sources[kind] = sorted(
            bundles, key=lambda row: (rng.value(row["pool_task_id"], 0), row["pool_task_id"])
        )
    requested = {kind: config[kind + "_count"] for kind in sources}
    shortage = {kind: max(0, requested[kind] - len(rows)) for kind, rows in sources.items()}
    selected = (
        []
        if any(shortage.values())
        else [row for kind, rows in sources.items() for row in rows[: requested[kind]]]
    )
    return freeze(
        root / "result.json",
        {
            "schema_version": 1,
            "status": "insufficient" if any(shortage.values()) else "ready",
            "environment_id": session.identity,
            "family": config["family"],
            "requested": requested,
            "available": {kind: len(rows) for kind, rows in sources.items()},
            "shortage": shortage,
            "selected": selected,
            "source_inventory_digest": digest(sources),
            "training_eligible": False,
            "admission": "requires a new explicit search run",
        },
    )


def main():
    parser = argparse.ArgumentParser(
        description="Seal a retail fixed/generated pool without new model calls"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    args = parser.parse_args()
    result = asyncio.run(build_pool(args.workspace, args.tau2_source, read_json(args.input)))
    print(
        json.dumps(
            {
                "status": result["status"],
                "selected": len(result["selected"]),
                "shortage": result["shortage"],
            }
        )
    )


if __name__ == "__main__":
    main()
