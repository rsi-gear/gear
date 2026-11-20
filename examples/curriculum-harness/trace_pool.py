"""Admit calibrated TRACE environments as explicit synthetic retail practice tasks.

This concrete caller performs conversion and execution. Native retail holdouts
keep their original environment and verifier; generated code is training-only.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from gear.canonical import digest
from ifeval_experiment import read_json
from trace_calibrate import verify_environment
from trace_environment import TraceEnvironment, freeze


def public_instruction(snapshot):
    return json.dumps(
        {key: snapshot[key] for key in ("system_prompt", "tools", "messages")},
        ensure_ascii=False,
        sort_keys=True,
        allow_nan=False,
    )


def environment_for_task(root, bundle):
    required = {
        "kind",
        "partition",
        "family",
        "environment",
        "seed",
        "instruction",
        "success_threshold",
        "pool_task_id",
        "calibration_digest",
        "provenance",
    }
    if (
        set(bundle) - {"gear_task_id"} != required
        or bundle["kind"] != "trace"
        or bundle["partition"] != "train"
        or not isinstance(bundle["family"], str)
        or not bundle["family"].strip()
        or type(bundle["seed"]) is not int
        or not 0 <= bundle["seed"] < 2**31
        or type(bundle["success_threshold"]) not in (int, float)
        or not 0 < bundle["success_threshold"] <= 1
        or not isinstance(bundle["instruction"], str)
        or not bundle["instruction"].strip()
        or bundle["provenance"].get("recipe") != "trace"
    ):
        raise ValueError("TRACE tasks require the explicit sealed training bundle")
    value = bundle["environment"]
    if set(value) != {"code", "identity"}:
        raise ValueError("TRACE task must bind generated code and execution identity")
    identity = value["identity"]
    environment = TraceEnvironment(
        root,
        value["code"],
        list(identity["tools"].values()),
        **{key: identity[key] for key in ("image", "timeout_seconds", "max_output_bytes")},
    )
    if environment.identity != identity or bundle["pool_task_id"] != digest(
        [environment.environment_id, bundle["seed"]]
    ):
        raise ValueError("TRACE task changed code, environment identity or seed")
    return environment


def verify_task(root, bundle):
    environment = environment_for_task(root, bundle)
    verification = verify_environment(environment, [bundle["seed"]])
    if (
        digest(verification) != bundle["calibration_digest"]
        or public_instruction(verification["records"][0]["traces"]["reference"]["snapshots"][0])
        != bundle["instruction"]
    ):
        raise ValueError("TRACE task public context or executed verification changed")
    return verification


async def replay_tasks(root, source_root, entry, *, family, source_tools):
    if (
        set(entry) != {"recipe", "workspace", "draft_id", "seeds"}
        or entry["recipe"] != "trace"
        or not isinstance(entry["workspace"], str)
        or not Path(entry["workspace"]).is_absolute()
        or not isinstance(entry["draft_id"], str)
        or not entry["draft_id"]
        or not isinstance(entry["seeds"], list)
        or not 1 <= len(entry["seeds"]) <= 128
        or any(type(seed) is not int or not 0 <= seed < 2**31 for seed in entry["seeds"])
        or len(set(entry["seeds"])) != len(entry["seeds"])
    ):
        raise ValueError("TRACE pool entries require a selected draft and distinct explicit seeds")
    source = Path(entry["workspace"]).resolve()
    identity = read_json(source / "input.json")
    if identity["config"]["family"] != family or set(entry["seeds"]) & set(
        identity["config"]["seeds"]
    ):
        raise ValueError(
            "TRACE practice must keep its source family and use new calibration-disjoint seeds"
        )
    # Imported here to keep generation independent of pool/search composition.
    from trace_generate import replay_generated

    result = await replay_generated(source, source_root)
    if result["status"] != "ready" or entry["draft_id"] not in result["selected"]:
        raise ValueError("TRACE pool requires an environment that passed complete calibration")
    attempts = [
        row
        for row in result["attempts"]
        if row.get("draft", {}).get("draft_id") == entry["draft_id"]
    ]
    if len(attempts) != 1 or attempts[0]["status"] != "ready":
        raise ValueError("TRACE pool draft is ambiguous or unvalidated")
    attempt = attempts[0]
    value = attempt["draft"]["data"]["environment"]
    if value["identity"]["tools"] != {tool["function"]["name"]: tool for tool in source_tools}:
        raise ValueError("TRACE original tool interface differs from the retail training domain")
    provenance = {
        "kind": "generated",
        "recipe": "trace",
        "workspace": str(source),
        "input_digest": digest(identity),
        "result_digest": digest(result),
        "draft_id": entry["draft_id"],
        "source_policy_id": result["source_policy_id"],
        "calibration_policy_id": attempt["calibration_policy_id"],
    }
    environment = TraceEnvironment(
        Path(root) / "environment",
        value["code"],
        source_tools,
        **{key: value["identity"][key] for key in ("image", "timeout_seconds", "max_output_bytes")},
    )
    executed = await asyncio.to_thread(verify_environment, environment, entry["seeds"])
    previous = read_json(source / f"candidates/{attempt['revision']}/verification.json")
    observed = {
        public_instruction(row["traces"]["reference"]["snapshots"][0])
        for row in previous["records"]
    }
    bundles = []
    for record in executed["records"]:
        seed = record["seed"]
        instruction = public_instruction(record["traces"]["reference"]["snapshots"][0])
        if instruction in observed:
            raise ValueError("TRACE practice repeated a calibrated or already admitted public task")
        observed.add(instruction)
        verification = {
            "environment_id": environment.environment_id,
            "records": [record],
            "distinct_initial_contexts": 1,
        }
        freeze(Path(root) / f"verification/{seed}.json", verification)
        bundle = {
            "kind": "trace",
            "partition": "train",
            "family": family,
            "environment": value,
            "seed": seed,
            "instruction": instruction,
            "success_threshold": identity["config"]["thresholds"]["success_threshold"],
            "pool_task_id": digest([environment.environment_id, seed]),
            "calibration_digest": digest(verification),
            "provenance": provenance,
        }
        environment_for_task(Path(root) / "environment", bundle)
        bundles.append(bundle)
    return bundles
