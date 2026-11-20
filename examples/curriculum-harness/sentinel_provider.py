"""Gear process provider for fixed-weight retail tool execution and scoped Meta.

Only AGENTS.md is interpreted from a Pi-format candidate. Actual retail tools,
user simulation and native grading run in this caller, outside curriculum.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import importlib.metadata
import inspect
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from formal_provider import prepare_jobs as prepare_meta
from gear.canonical import digest
from gear.core.schema import validate_output
from ifeval_experiment import read_json
from model_calls import TextCalls, token_usage
from sentinel_collect import RetailCollector
from sentinel_generate import freeze, implementation_identity
from sentinel_retail import load_backend


class PendingModel(RuntimeError):
    def __init__(self, state):
        self.state = state


def provider_identity(config, calls_factory):
    try:
        sdk = importlib.metadata.version("openai-codex")
    except importlib.metadata.PackageNotFoundError:
        sdk = None
    return digest(
        {
            "implementation": implementation_identity(),
            "meta_conversion": hashlib.sha256(
                Path(__file__).with_name("formal_provider.py").read_bytes()
            ).hexdigest(),
            "backend": load_backend(config["tau2_source"])["identity"],
            "calls_factory": [
                calls_factory.__module__,
                calls_factory.__qualname__,
                hashlib.sha256(Path(inspect.getsourcefile(calls_factory)).read_bytes()).hexdigest(),
            ],
            "sdk": sdk,
        }
    )


def prepare_jobs(config, context, request):
    """Bind every slot to an admitted payload; Meta sees only declared train tasks."""
    if (
        request.get("generationLimits") is not None
        or request.get("projection")
        or request.get("repair")
    ):
        raise ValueError(
            "retail provider requires explicit recovery and has no hard generation allowance"
        )
    operation = request["operation"]
    scopes = {key: set(config[key + "_task_ids"]) for key in ("train", "validation", "test")}
    if any(
        scopes[a] & scopes[b]
        for a, b in (("train", "validation"), ("train", "test"), ("validation", "test"))
    ):
        raise ValueError("retail task partitions overlap")
    trace_tasks = config.get("trace_tasks", {})
    if not isinstance(trace_tasks, dict) or not set(trace_tasks) <= scopes["train"]:
        raise ValueError("TRACE execution must be explicitly admitted inside training")
    if request.get("operatorCall"):
        if not set(operation["task_ids"]) <= scopes["train"]:
            raise ValueError("Meta requested material outside the training scope")
        jobs = prepare_meta(context, request)
        if "agentr_context" in config:
            from agentr_harness import add_context

            jobs = add_context(config["agentr_context"], scopes, context, request, jobs)
        return jobs
    if (
        operation["kind"] != "evaluate_seed"
        or request["partition"] != "seed"
        or "benchmark" not in context
    ):
        raise ValueError("retail search provider only evaluates explicit training/selection slots")
    target_id = request.get("executionTarget", {}).get("id", operation["candidate_id"])
    targets = Path(context["targets"]).resolve()
    target = (targets / target_id).resolve()
    if target.parent != targets:
        raise ValueError("invalid candidate path")
    if read_json(target / ".pi/settings.json") != {} or any(
        path.is_file()
        for folder in ("extensions", "skills", "prompts")
        for path in (target / ".pi" / folder).rglob("*")
    ):
        raise ValueError("retail caller supports AGENTS.md only, not Pi settings or extensions")
    harness = (target / "AGENTS.md").read_text()
    tasks = {row["id"]: row for row in context["benchmark"]["tasks"]}
    jobs, seen = [], set()
    for slot in request["slots"]:
        key = (slot["taskId"], slot["repetition"])
        if key in seen or type(slot["repetition"]) is not int or slot["repetition"] < 0:
            raise ValueError("duplicate or invalid retail slot")
        seen.add(key)
        identifier = slot["taskId"]
        if identifier not in operation["task_ids"]:
            raise ValueError("slot is outside the reserved task set")
        partition = (
            "train"
            if identifier in scopes["train"]
            else "validation"
            if identifier in scopes["validation"]
            else None
        )
        bundle = json.loads(context["benchmark"]["verifiers"][identifier]["expected"])
        synthetic = bundle.get("kind") == "trace"
        if synthetic != (identifier in trace_tasks) or (
            synthetic and digest(bundle) != trace_tasks[identifier]
        ):
            raise ValueError("TRACE bundle differs from its explicit frozen admission")
        if (
            partition is None
            or bundle["partition"] != partition
            or bundle["gear_task_id"] != identifier
            or (bundle["instruction"] if synthetic else bundle["task"]["ticket"])
            != tasks[identifier]["instruction"]
            or bundle["family"] != tasks[identifier]["family"]
        ):
            raise ValueError("retail verifier differs from the admitted task or partition")
        jobs.append(
            {
                "slot": slot,
                "bundle": bundle,
                "harness": harness,
                "key": request["runId"]
                + "/"
                + request["operationId"]
                + "/"
                + identifier
                + "/"
                + str(slot["repetition"]),
            }
        )
    if not jobs:
        raise ValueError("retail evaluation requires an explicit nonempty sample plan")
    return jobs


async def respond(message, *, calls_factory=TextCalls):
    config = message["configuration"]
    if (
        type(config["max_calls"]) is not int
        or config["max_calls"] < 1
        or type(config["max_steps"]) is not int
        or not 1 <= config["max_steps"] <= 64
    ):
        raise ValueError("retail provider requires bounded steps and a positive model-call quota")
    identity = provider_identity(config, calls_factory)
    action = message["action"]
    if action == "describe":
        return {
            "version": 1,
            "identity": identity,
            "capabilities": {
                "seeds": False,
                "temperature": False,
                "subsets": True,
                "idempotentSubmission": True,
                "inspect": True,
                "cancel": False,
                "physicalAttemptAccounting": True,
                "evidenceProjection": False,
                "generationBudget": False,
                "hardDollarBudget": False,
                "operatorMeta": True,
            },
        }
    if action not in ("submit", "inspect"):
        raise ValueError("unsupported retail provider action")
    context, request = message["context"], message["request"]
    jobs = prepare_jobs(config, context, request)
    directory = Path(config["receipts"]) / digest(
        [request["runId"], request["operationId"]]
    ).removeprefix("sha256:")
    directory.mkdir(parents=True, exist_ok=True)
    binding = digest([request, context, config, identity])
    with (directory / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if action == "inspect":
                return {"state": "running"}
            raise RuntimeError("retail operation is already running") from None
        if (directory / "receipt.json").exists():
            saved = read_json(directory / "receipt.json")
            if saved["binding"] != binding or digest(saved["receipt"]) != saved["digest"]:
                raise ValueError("retail operation receipt or request changed")
            return (
                {"state": "complete", "receipt": saved["receipt"]}
                if action == "inspect"
                else saved["receipt"]
            )
        if not (directory / "intent.json").exists() and action == "inspect":
            return {"state": "not_submitted"}
        freeze(directory / "intent.json", {"binding": binding})
        receipts, evidence, samples = {}, [], []
        data = None
        async with calls_factory(
            Path(config["calls"]), max_calls=config["max_calls"], concurrency=1
        ) as calls:

            async def model_call(key, prompt, harness, **settings):
                freeze(
                    directory / "model-inputs" / (digest(key).removeprefix("sha256:") + ".json"),
                    {"key": key, "prompt": prompt, "harness": harness, "settings": settings},
                )
                if action == "inspect":
                    state, receipt = await calls.inspect(key)
                    if state != "complete":
                        raise PendingModel("resumable" if state == "not_submitted" else "unknown")
                else:
                    receipt = await calls.call(key, prompt, harness, **settings)
                if receipt.get("status") != "completed":
                    raise PendingModel("unknown")
                receipts[key] = receipt
                return receipt

            try:
                if request.get("operatorCall"):
                    job = jobs[0]
                    receipt = await model_call(
                        job["key"],
                        job["prompt"],
                        job["harness"],
                        model=config["model"],
                        effort=config["effort"],
                        output_schema=job["schema"],
                    )
                    value = json.loads(receipt["response"])
                    validate_output(job["schema"], value)
                    data = {"declined": False, "data": value}
                else:
                    for job in jobs:

                        async def scoped_call(key, prompt, harness, **settings):
                            return await model_call(
                                job["key"] + "/" + key, prompt, harness, **settings
                            )

                        sample_root = (
                            directory / "samples" / digest(job["key"]).removeprefix("sha256:")
                        )
                        scoped = SimpleNamespace(
                            call=scoped_call,
                            root=calls.root,
                            max_calls=2 * config["max_steps"] + 1,
                            identity=getattr(calls, "identity", "TextCalls"),
                            timeout_seconds=getattr(calls, "timeout_seconds", None),
                        )
                        bundle = job["bundle"]
                        if bundle.get("kind") == "trace":
                            from trace_calibrate import TraceCollector
                            from trace_pool import environment_for_task, public_instruction

                            environment = environment_for_task(sample_root / "environment", bundle)
                            initial = (
                                await asyncio.to_thread(environment.replay, bundle["seed"], [])
                            )["snapshots"][0]
                            if public_instruction(initial) != bundle["instruction"]:
                                raise ValueError(
                                    "TRACE public input differs from the admitted task"
                                )
                            freeze(sample_root / "steps/0.json", initial)
                            sample_config = {
                                "schema_version": 1,
                                "model": config["model"],
                                "effort": config["effort"],
                                "harness": job["harness"],
                                "max_steps": config["max_steps"],
                                "max_calls": scoped.max_calls,
                                "sample_id": job["key"],
                                "seed": bundle["seed"],
                                "sample_idx": 0,
                            }
                            result = await TraceCollector(
                                sample_root, environment, sample_config, scoped
                            ).collect()
                            trace = read_json(sample_root / "trajectory.json")
                            evidence.append(
                                {
                                    "candidate_id": request["operation"]["candidate_id"],
                                    "task_id": job["slot"]["taskId"],
                                    "repetition": job["slot"]["repetition"],
                                    "scope": request["operation"]["scope"],
                                    "status": "valid" if result["complete"] else "task_failed",
                                    "score": int(result["reward"] >= bundle["success_threshold"])
                                    if result["complete"]
                                    else None,
                                    "feedback": json.dumps(
                                        {
                                            "complete": result["complete"],
                                            "reward": result["reward"],
                                            "success_threshold": bundle["success_threshold"],
                                            "actions": trace["actions"],
                                            "messages": trace["snapshots"][-1]["messages"],
                                            "trajectory_digest": digest(trace),
                                            "environment_id": result["environment_id"],
                                        }
                                    ),
                                }
                            )
                            samples.append(
                                {
                                    "task_id": job["slot"]["taskId"],
                                    "partition": "train",
                                    "kind": "trace",
                                    "path": str(sample_root),
                                    "result_digest": digest(result),
                                }
                            )
                            continue
                        sample_config = {
                            key: bundle[key]
                            for key in (
                                "partition",
                                "family",
                                "database",
                                "user_id",
                                "task",
                                "reference",
                            )
                        }
                        sample_config.update(
                            schema_version=1,
                            model=config["model"],
                            effort=config["effort"],
                            harness=job["harness"],
                            max_steps=config["max_steps"],
                            max_calls=scoped.max_calls,
                            sample_id=job["key"],
                            attempt=0,
                        )
                        result = await RetailCollector(
                            sample_root, config["tau2_source"], sample_config, scoped
                        ).collect()
                        record = result["observation"]["record"]
                        trace = read_json(sample_root / "trajectory.json")
                        evidence.append(
                            {
                                "candidate_id": request["operation"]["candidate_id"],
                                "task_id": job["slot"]["taskId"],
                                "repetition": job["slot"]["repetition"],
                                "scope": request["operation"]["scope"],
                                "status": "valid" if record["complete"] else "task_failed",
                                "score": int(record["passed"]) if record["complete"] else None,
                                "feedback": json.dumps(
                                    {
                                        "feedback": record["feedback"],
                                        "steps": trace["steps"],
                                        "complete": record["complete"],
                                        "trajectory_digest": digest(trace),
                                    }
                                ),
                            }
                        )
                        samples.append(
                            {
                                "task_id": job["slot"]["taskId"],
                                "partition": record["partition"],
                                "path": str(sample_root),
                                "result_digest": digest(result),
                            }
                        )
            except PendingModel as pending:
                if action == "inspect":
                    return {"state": pending.state}
                raise RuntimeError(
                    "retail model result is unknown; reconcile the original turn"
                ) from None
        receipt = {
            "result": {
                "operation_id": request["operationId"],
                "kind": request["operation"]["kind"],
                "candidate_id": request["operation"]["candidate_id"],
                "status": "complete",
                "data": data,
            },
            "candidate": None,
            "evidence": evidence,
            "physicalAttempts": len(evidence),
            "usage": token_usage(list(receipts.values())),
            "provenance": {
                "provider": "sentinel-retail",
                "implementation": identity,
                "logical_model_calls": len(receipts),
                "call_keys": sorted(receipts),
                "http_request_count": "unknown",
                "hard_generation_budget": False,
                "samples": samples,
                **(
                    {"agentr_context": jobs[0]["agentr_context"]}
                    if request.get("operatorCall") and "agentr_context" in jobs[0]
                    else {}
                ),
            },
        }
        freeze(
            directory / "receipt.json",
            {"binding": binding, "digest": digest(receipt), "receipt": receipt},
        )
        return {"state": "complete", "receipt": receipt} if action == "inspect" else receipt


if __name__ == "__main__":
    print(json.dumps(asyncio.run(respond(json.load(sys.stdin)))))
