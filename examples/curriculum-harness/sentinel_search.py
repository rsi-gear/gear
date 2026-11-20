"""Admit a validated retail pool into a fresh, fixed-weight Project.refine run."""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import hashlib
import json
import os
import shlex
import sys
from pathlib import Path

from gear import Project
from gear.algorithms import ReflectiveSearch
from gear.canonical import digest
from gear.search import PromptConstraints
from ifeval_experiment import read_json
from sentinel_generate import freeze, implementation_identity
from sentinel_pool import build_pool
from sentinel_retail import RetailSession, calibrate, load_backend, validate_task


def frozen_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text() != text:
        raise ValueError("retail search artifact changed: " + str(path))
    path.write_text(text)


async def search(root, source_root, config, *, provider_script=None, preflight=False):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return await _search(root, source_root, config, provider_script, preflight)


async def _search(root, source_root, config, provider_script, preflight):
    expected = {
        "schema_version",
        "pool_workspace",
        "validation",
        "test",
        "harness",
        "model",
        "meta_model",
        "effort",
        "max_steps",
        "max_calls",
        "max_characters",
        "target_characters",
        "max_repairs",
    }
    if (
        set(config) - {"agentr_workspaces", "final_reply_on_limit", "call_timeout_seconds"}
        != expected
        or type(config["schema_version"]) is not int
        or config["schema_version"] != 1
    ):
        raise ValueError("retail search requires the explicit pool and holdout configuration")
    if any(
        not isinstance(config[key], str) or not config[key].strip()
        for key in ("harness", "model", "meta_model", "effort")
    ):
        raise ValueError("retail search model and harness settings must be nonempty")
    if type(config.get("final_reply_on_limit", False)) is not bool:
        raise ValueError("final_reply_on_limit must be an explicit boolean")
    if "call_timeout_seconds" in config and (
        type(config["call_timeout_seconds"]) is not int
        or not 1 <= config["call_timeout_seconds"] <= 1800
    ):
        raise ValueError("call_timeout_seconds must be an integer from 1 to 1800")
    if (
        type(config["max_steps"]) is not int
        or not 1 <= config["max_steps"] <= 64
        or type(config["max_calls"]) is not int
        or config["max_calls"] < 1
    ):
        raise ValueError("retail search requires bounded steps and model calls")
    config = json.loads(json.dumps(config, allow_nan=False))
    pool_root = Path(config["pool_workspace"]).resolve()
    pool_input = read_json(pool_root / "input.json")
    pool = await build_pool(root / "pool-check", source_root, pool_input["config"])
    if read_json(root / "pool-check/input.json") != pool_input or pool != read_json(
        pool_root / "result.json"
    ):
        raise ValueError("retail pool or its frozen implementation changed")
    if pool["status"] != "ready" or not pool["selected"]:
        raise ValueError("retail search requires a complete validated pool; no fallback admission")
    backend = load_backend(source_root)
    bundles = {
        "train": pool["selected"],
        "validation": config["validation"],
        "test": config["test"],
    }
    ids, content, families, rows, admission = set(), set(), {}, [], []
    scopes, trace_tasks, native_train = {}, {}, {}
    for partition, values in bundles.items():
        if not isinstance(values, list) or not 1 <= len(values) <= 256:
            raise ValueError("each retail partition needs a bounded nonempty task list")
        scopes[partition] = []
        families[partition] = set()
        for bundle in values:
            if (
                bundle["partition"] != partition
                or not isinstance(bundle["family"], str)
                or not bundle["family"].strip()
            ):
                raise ValueError("retail task partition or family changed")
            if partition != "train" and not bundle.get("evidence_refs"):
                raise ValueError("private tasks require caller-authorized source evidence")
            synthetic = bundle.get("kind") == "trace"
            if synthetic:
                if partition != "train":
                    raise ValueError(
                        "TRACE generated environments are training-only; holdouts stay native"
                    )
                from trace_pool import verify_task

                task_id, instruction = bundle["pool_task_id"], bundle["instruction"]
                calibration = await asyncio.to_thread(
                    verify_task, root / "trace" / task_id.removeprefix("sha256:"), bundle
                )
                fingerprint = task_id
            else:
                task = validate_task(bundle["task"], bundle["reference"])
                task_id, instruction = task.id, task.ticket
                session = RetailSession(backend, bundle["database"], bundle["user_id"])
                calibration = calibrate(
                    backend, bundle["database"], bundle["user_id"], bundle["reference"], task
                )
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
            if task_id in ids or fingerprint in content:
                raise ValueError("retail tasks or exact content overlap across partitions")
            ids.add(task_id)
            content.add(fingerprint)
            families[partition].add(bundle["family"])
            gear_id = ("trace-" if synthetic else "retail-") + digest(
                [partition, task_id, fingerprint]
            ).removeprefix("sha256:")
            scopes[partition].append(gear_id)
            admitted_bundle = {**bundle, "gear_task_id": gear_id}
            if synthetic:
                trace_tasks[gear_id] = digest(admitted_bundle)
            elif partition == "train":
                native_train[gear_id] = admitted_bundle
            admission.append(
                {
                    "gear_task_id": gear_id,
                    "native_task_id": None if synthetic else task_id,
                    **({"environment_task_id": task_id} if synthetic else {}),
                    "partition": partition,
                    "bundle_digest": digest(admitted_bundle),
                }
            )
            freeze(
                root / "calibration" / (digest(task_id).removeprefix("sha256:") + ".json"),
                calibration,
            )
            rows.append(
                {
                    "id": gear_id,
                    "instruction": instruction,
                    "family": bundle["family"],
                    "split": "held_out" if partition == "test" else "seed",
                    "expected": json.dumps(admitted_bundle),
                }
            )
    if any(
        families[a] & families[b]
        for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
    ):
        raise ValueError("retail training, selection and test families must be disjoint")
    agentr_context = None
    if "agentr_workspaces" in config:
        from agentr_harness import prepare_context

        agentr_context = await prepare_context(
            root / "agentr-context.json",
            source_root,
            config["agentr_workspaces"],
            native_train,
            config,
        )
    algorithm = ReflectiveSearch(
        tuple(scopes["train"]),
        tuple(scopes["validation"]),
        constraints=PromptConstraints(config["max_characters"]),
        target_characters=config["target_characters"],
        max_repairs=config["max_repairs"],
        nominate=False,
        training_gate=True,
    )
    provider_script = Path(
        provider_script or Path(__file__).with_name("sentinel_provider.py")
    ).resolve()
    profile_root = Path(os.environ["GEAR_PROFILE_ROOT"]).resolve()
    identity = {
        "config": config,
        "pool_digest": digest(pool),
        "implementation": implementation_identity(),
        "algorithm": algorithm.describe().to_dict(),
        "provider": {
            "path": str(provider_script),
            "digest": hashlib.sha256(provider_script.read_bytes()).hexdigest(),
        },
        "backend": backend["identity"],
        "python": sys.executable,
        "profiles": str(profile_root),
        **({"agentr_context": agentr_context} if agentr_context is not None else {}),
    }
    freeze(root / "input.json", identity)
    freeze(root / "admission.json", admission)
    directory = root / "project"
    for folder in ("extensions", "skills", "prompts"):
        (directory / "target/.pi" / folder).mkdir(parents=True, exist_ok=True)
    frozen_text(directory / "target/AGENTS.md", config["harness"])
    freeze(directory / "target/.pi/settings.json", {})
    suffix = digest(str(root)).removeprefix("sha256:")[:16]
    names = {role: "sentinel-" + role + "-" + suffix for role in ("target", "meta")}
    freeze(
        directory / "gear.yaml",
        {
            "version": 1,
            "benchmark": "./benchmark.yaml",
            "target": {"adapter": "pi", "path": "./target", "profile": names["target"]},
            "meta": {"profile": names["meta"]},
            "algorithm": "opro",
            "objective": {"metric": "pass_rate"},
            "validation": {"mode": "holdout"},
            "budget": {
                "rounds": 1,
                "max_candidates": 2,
                "repetitions": 1,
                "max_evaluations": 2 * (len(scopes["train"]) + len(scopes["validation"])),
            },
            "evaluation": {"repair": {"max_retries": 0, "max_projections": 0, "backoff_ms": [0]}},
        },
    )
    freeze(
        directory / "benchmark.yaml", {"version": 1, "source": "./tasks.jsonl", "template": "text"}
    )
    frozen_text(directory / "tasks.jsonl", "".join(json.dumps(row) + "\n" for row in rows))
    project = Project.open(directory)
    launcher = root / "provider-launcher.sh"
    frozen_text(
        launcher, "#!/bin/sh\nexec " + shlex.join([sys.executable, str(provider_script)]) + "\n"
    )
    profile_root.mkdir(parents=True, exist_ok=True)
    for role, model in (("target", config["model"]), ("meta", config["meta_model"])):
        profile = {
            "command": ["/bin/sh", str(launcher)],
            "workingDirectory": str(Path(__file__).resolve().parents[2]),
            "passEnv": ["PYTHONPATH"],
            "timeoutMs": 1800000,
            "configuration": {
                "calls": str(root / "calls"),
                "receipts": str(root / "operations"),
                "max_calls": config["max_calls"],
                "max_steps": config["max_steps"],
                "model": model,
                "effort": config["effort"],
                "tau2_source": str(Path(source_root).resolve()),
                "trace_tasks": trace_tasks,
                **(
                    {"final_reply_on_limit": config["final_reply_on_limit"]}
                    if "final_reply_on_limit" in config
                    else {}
                ),
                **(
                    {"call_timeout_seconds": config["call_timeout_seconds"]}
                    if "call_timeout_seconds" in config
                    else {}
                ),
                **(
                    {"agentr_context": agentr_context}
                    if role == "meta" and agentr_context is not None
                    else {}
                ),
                **{key + "_task_ids": value for key, value in scopes.items()},
            },
        }
        profile_path = profile_root / (names[role] + ".json")
        if profile_path.exists():
            if read_json(profile_path) != profile:
                raise ValueError("retail process profile changed")
        else:
            await project.acreate_profile(names[role], profile)
    if preflight:
        await project.acheck()
        return await project.aplan_refine(algorithm=algorithm, rounds=1)
    journals = list((directory / ".gear/runs").glob("*/journal.json"))
    if len(journals) > 1:
        raise ValueError("retail search workspace contains ambiguous runs")
    if journals:
        run_id = journals[0].parent.name
        report = (await project.areport(run_id)).summary
        if report["status"] != "completed":
            report = (await project.aresume(run_id)).report.summary
    else:
        run = await project.arefine(algorithm=algorithm, rounds=1)
        run_id, report = run.id, run.report.summary
    if report["status"] != "completed" or report["nominee"] is not None:
        raise RuntimeError("retail refinement did not finish without final-test nomination")
    run_root = directory / ".gear/runs" / run_id
    journal = read_json(run_root / "journal.json")
    if (
        digest({key: value for key, value in journal.items() if key != "digest"})
        != journal["digest"]
        or journal["heldOutEvidence"]
    ):
        raise ValueError("retail search journal changed or opened the final test")
    outcome = report["operators"]["outcome"]
    selected = outcome.get("selected")
    retained = None
    if selected is None:
        if outcome.get("status") != "incomplete_training_evidence":
            raise ValueError("retail search ended without a selection or incomplete evidence")
        # A native step limit has no score. Preserve the original candidate, but
        # do not turn this interrupted comparison into a successful selection.
        anchor = next(row for row in journal["candidates"] if row["id"] == "anchor")
        retained = {"run_id": run_id, "candidate_id": anchor["id"], "digest": anchor["digest"]}
    effective = selected or retained
    manifest = read_json(run_root / "target-manifests" / (effective["candidate_id"] + ".json"))
    harness = (run_root / "targets" / effective["candidate_id"] / "AGENTS.md").read_text()
    if (
        manifest["digest"] != effective["digest"]
        or digest({key: value for key, value in manifest.items() if key != "digest"})
        != effective["digest"]
    ):
        raise ValueError("selected retail candidate manifest changed")
    resource = next(item for item in manifest["resources"] if item["path"] == "AGENTS.md")
    if resource["digest"] != digest(base64.b64encode(harness.encode()).decode()):
        raise ValueError("selected retail prompt differs from its sealed bytes")
    records = [
        record
        for step in journal["operators"]["decisions"]
        for record in step["decision"]["records"]
    ]
    context_result = {}
    if agentr_context is not None:
        snapshot = read_json(Path(agentr_context["path"]))
        if digest(snapshot) != agentr_context["digest"]:
            raise ValueError("Agent-R context changed before recording the search result")
        context_result = {
            "agentr_context_digest": agentr_context["digest"],
            "agentr_generation_usage": snapshot["generation_usage"],
            "agentr_source_collection_usage": snapshot["source_collection_usage"],
        }
    return freeze(
        root / "result.json",
        {
            "run_id": run_id,
            "status": "completed" if selected is not None else "incomplete_training_evidence",
            "selected": selected,
            **({"retained": retained} if retained is not None else {}),
            "harness": harness,
            "outcome": outcome,
            "constraints": [record for record in records if record["kind"] == "prompt_constraints"],
            "training_gates": [
                record for record in records if record["kind"] == "training_acceptance"
            ],
            "physical_attempts": journal["physicalAttempts"],
            "test_opened": False,
            "pool_digest": digest(pool),
            "admission_digest": digest(admission),
            "task_ids": scopes,
            **context_result,
        },
    )


def main():
    parser = argparse.ArgumentParser(description="Refine a retail harness without GPU training")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    os.environ.setdefault("GEAR_PROFILE_ROOT", str(args.workspace.resolve() / "profiles"))
    result = asyncio.run(
        search(args.workspace, args.tau2_source, read_json(args.input), preflight=args.preflight)
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
