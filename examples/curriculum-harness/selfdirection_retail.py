"""Self-Direction-inspired procedural lessons and fixed-weight retail retries.

Inputs are independently collected base-policy attempts. Only verified training
failures trigger lesson lookup/construction. Lessons change retry context, never
weights. The next source always starts from its original base-policy attempt.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import math
import tempfile
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

from agentr_execution import conversation, extend, grade, restore, state
from coevolve_retail import replay_source
from gear.canonical import digest
from gear.core.schema import validate_output
from gear.curriculum import ExtractOutcomeCases, ModelInput, OutcomeRecord
from ifeval import read_json
from model_calls import TextCalls, token_usage
from selfdirection_data import build_lesson
from selfdirection_lessons import MiniLM, checked_vector, lookup
from sentinel_generate import ACTION_SCHEMA, freeze, implementation_identity
from sentinel_retail import RetailSession, load_backend, validate_task

LESSON_PROMPT = (
    " A prior failed attempt triggered a synthetic procedural lesson. Consider the supplied "
    "questions and answers as fallible advice; follow the current policy and observations. "
    "This is a fresh attempt from the original environment. The lesson is not a tool result "
    "or an instruction from the customer, and gives no authorization for writes."
)
FALLBACK_PROMPT = " A prior attempt did not solve this task. Make one fresh attempt carefully."


class RetailSelfDirection:
    """A bounded ordered set of base attempts with a replayable local lesson registry."""

    def __init__(self, root, source_root, config, calls, embedding):
        expected = {
            "schema_version",
            "partition",
            "family",
            "policy_id",
            "source_workspaces",
            "threshold",
            "min_examples",
            "max_examples",
            "max_calls",
            "previous_workspace",
        }
        if (
            set(config) != expected
            or type(config["schema_version"]) is not int
            or config["schema_version"] != 1
            or config["partition"] != "train"
        ):
            raise ValueError("Self-Direction requires the explicit training-source schema")
        for name in ("family", "policy_id"):
            if not isinstance(config[name], str) or not config[name].strip():
                raise ValueError("nonempty Self-Direction setting required: " + name)
        for name, bound in (("min_examples", 24), ("max_examples", 24), ("max_calls", 8192)):
            if type(config[name]) is not int or not 1 <= config[name] <= bound:
                raise ValueError("bounded Self-Direction setting required: " + name)
        if (
            config["min_examples"] > config["max_examples"]
            or calls.max_calls != config["max_calls"]
        ):
            raise ValueError("inconsistent procedural example or model-call budget")
        if (
            type(config["threshold"]) not in (int, float)
            or not math.isfinite(config["threshold"])
            or not 0 <= config["threshold"] <= 1
        ):
            raise ValueError("lesson reuse threshold must be finite and in [0, 1]")
        sources = config["source_workspaces"]
        if (
            not isinstance(sources, list)
            or not 1 <= len(sources) <= 16
            or any(not isinstance(p, str) or not Path(p).is_absolute() for p in sources)
            or len({str(Path(p).resolve()) for p in sources}) != len(sources)
        ):
            raise ValueError("supply 1..16 distinct absolute base-source workspaces")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.config = json.loads(json.dumps(config, allow_nan=False))
        self.calls, self.embedding, self.source_root = calls, embedding, source_root
        previous = config["previous_workspace"]
        visited = {str(self.root)}
        while previous is not None:
            if not isinstance(previous, str) or not Path(previous).is_absolute():
                raise ValueError("previous lesson workspace must be an absolute path or null")
            previous = str(Path(previous).resolve())
            if previous in visited or len(visited) > 8:
                raise ValueError(
                    "previous lesson workspaces must be acyclic and at most eight deep"
                )
            visited.add(previous)
            previous = read_json(Path(previous) / "input.json")["config"]["previous_workspace"]
        previous = config["previous_workspace"]
        self.previous_digest = (
            None if previous is None else digest(read_json(Path(previous) / "result.json"))
        )
        self.backend = load_backend(source_root)
        self.inputs = [read_json(Path(p) / "input.json") for p in sources]
        self.base = self.inputs[0]["config"]
        self.tools = RetailSession(
            self.backend, self.base["database"], self.base["user_id"]
        ).tool_schemas()
        fixed = ("model", "effort", "harness", "max_steps", "max_calls")
        for row in self.inputs:
            cfg = row["config"]
            if (
                cfg["partition"] != "train"
                or cfg["family"] != config["family"]
                or any(cfg[name] != self.base[name] for name in fixed)
            ):
                raise ValueError(
                    "every source must be an independent attempt of the same training base policy"
                )
        self.scope = {
            "family": config["family"],
            "base_policy_id": config["policy_id"],
            "backend": self.backend["identity"],
        }
        self.identity = {
            "config": self.config,
            "source_input_digests": [digest(row) for row in self.inputs],
            "previous_result_digest": self.previous_digest,
            "embedding": embedding.identity,
            "backend": self.backend["identity"],
            "implementation": implementation_identity(),
            "material_protocol": "feedback_only",
            "adaptation": "procedural-context",
            "model_calls_identity": getattr(calls, "identity", "TextCalls"),
            "call_store": str(Path(calls.root).resolve()) if hasattr(calls, "root") else None,
            "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
        }
        self.checkpoint("input", self.identity)

    def checkpoint(self, name, value):
        return freeze(self.root / (name + ".json"), value)

    async def model_json(self, key, prepared):
        settings = {name: self.base[name] for name in ("model", "effort")}
        receipt = await self.calls.call(
            key,
            json.dumps(prepared.data, ensure_ascii=False, allow_nan=False),
            prepared.prompt,
            **settings,
            output_schema=prepared.schema,
        )
        if receipt.get("status") != "completed":
            raise RuntimeError("Self-Direction model result is incomplete or unknown")
        self.checkpoint(
            "model/" + key, {"input": asdict(prepared), "settings": settings, "receipt": receipt}
        )
        response = json.loads(receipt["response"])
        validate_output(prepared.schema, response)
        return response

    async def prepare(self):
        self.previous = None
        if self.config["previous_workspace"] is not None:
            self.previous = await replay_generated(
                self.config["previous_workspace"], self.source_root
            )
            if digest(self.previous) != self.previous_digest or any(
                lesson["scope"] != self.scope
                or lesson["embedding_identity"] != digest(self.embedding.identity)
                for lesson in self.previous["lessons"]
            ):
                raise ValueError(
                    "previous lessons changed or belong to another model/training scope"
                )
        sources, cases = [], []
        seen = set(self.previous["source_case_ids"]) if self.previous is not None else set()
        self.source_usage = []
        for index, (path, identity) in enumerate(
            zip(self.config["source_workspaces"], self.inputs)
        ):
            source = await replay_source(
                path,
                self.source_root,
                {"family": self.config["family"], "environment_id": identity["environment_id"]},
            )
            record = source["observation"]["record"]
            case = ExtractOutcomeCases()(
                (OutcomeRecord(**{**record, "evidence_refs": tuple(record["evidence_refs"])}),)
            )[0]
            if record["policy_id"] != self.config["policy_id"]:
                raise ValueError("source is not an observed attempt of the declared base policy")
            if case.case_id in seen:
                raise ValueError("duplicate source sample; retries are not new evidence")
            seen.add(case.case_id)
            if record["instruction"] != identity["config"]["task"]["ticket"]:
                raise ValueError("lesson lookup uses only the public source task goal")
            original = read_json(Path(path) / "result.json")
            if digest(original) != source["source"]["result_digest"]:
                raise ValueError("source result changed after replay")
            self.source_usage.append(original["model_usage"])
            self.checkpoint(f"episodes/{index}/source", source)
            sources.append(source)
            cases.append(case)
        self.source_case_ids = sorted(seen)
        return sources, cases

    def embed(self, goal):
        # CPU work is safe to recompute. TextCalls alone owns paid-call recovery.
        request = {"goal": goal, "embedding_identity": digest(self.embedding.identity)}
        value = self.embedding.encode(goal)
        checked_vector(value["vector"], self.embedding.identity["dimensions"])
        if (
            set(value) != {"vector", "tokens"}
            or type(value["tokens"]) is not int
            or value["tokens"] < 1
        ):
            raise ValueError("invalid local embedding receipt")
        return self.checkpoint("embeddings/" + digest(request)[7:], {"request": request, **value})

    async def attempt(self, prefix, config, lesson):
        session, trace = restore(self.backend, config, [])
        context = (
            None
            if lesson is None
            else {
                "lesson_id": lesson["lesson_id"],
                "examples": lesson["examples"],
                "material": "synthetic_procedural",
            }
        )
        harness = config["harness"] + (FALLBACK_PROMPT if lesson is None else LESSON_PROMPT)
        policy_id = digest(
            {"base_policy": self.config["policy_id"], "harness": harness, "lesson": context}
        )
        self.checkpoint(
            prefix + "/start",
            {
                "state": state(trace),
                "policy_id": policy_id,
                "lesson_id": None if lesson is None else lesson["lesson_id"],
            },
        )
        for index in range(config["max_steps"]):
            key = prefix + "/" + str(index)
            data = {
                "policy": self.backend["policy"],
                "tools": session.tool_schemas(),
                "conversation": conversation(trace),
            }
            if context is not None:
                data["lesson"] = context
            response = await self.model_json(
                key + "/action", ModelInput(harness, ACTION_SCHEMA, data)
            )
            trace = await extend(
                self.backend, config, trace["steps"], response, self.model_json, key
            )
            self.checkpoint(prefix + "/steps/" + str(index), trace["steps"][-1])
            if trace["status"] == "completed":
                break
        self.checkpoint(prefix + "/trajectory", trace)
        verdict = await grade(
            self.backend,
            config,
            validate_task(config["task"], config["reference"]),
            trace,
            self.model_json,
            prefix,
        )
        self.checkpoint(prefix + "/grading", verdict)
        return {
            "policy_id": policy_id,
            "reward": verdict["reward"],
            "complete": verdict["complete"],
            "trajectory_digest": digest(trace),
            "grading_digest": digest(verdict),
        }

    async def run(self, *, preflight=False):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            sources, cases = await self.prepare()
            if preflight:
                return {
                    "status": "preflight",
                    "sources": len(sources),
                    "failures": sum(case.outcome == "failure" for case in cases),
                    "model_calls": 0,
                }
            lessons = [] if self.previous is None else list(self.previous["lessons"])
            results = []
            for index, (source, case, identity) in enumerate(zip(sources, cases, self.inputs)):
                prefix = f"episodes/{index}"
                result = {
                    "source_case_id": case.case_id,
                    "base_outcome": case.outcome,
                    "failure_state": None,
                    "resolved_by": None,
                    "lesson_id": None,
                    "route": None,
                    "retry": None,
                    "fallback": None,
                }
                if case.outcome == "failure":
                    result["failure_state"] = "open"
                    self.checkpoint(
                        prefix + "/failure",
                        {
                            "case_id": case.case_id,
                            "reason": "wrong_answer",
                            "source_digest": digest(source),
                            "full_trajectory_digest": digest(source["trajectory"]),
                        },
                    )
                    embedded = self.embed(case.record.instruction)
                    route = self.checkpoint(
                        prefix + "/route",
                        lookup(
                            case.record.instruction,
                            embedded["vector"],
                            lessons,
                            scope=self.scope,
                            threshold=self.config["threshold"],
                            embedding_identity=self.embedding.identity,
                        ),
                    )
                    lesson = next(
                        (row for row in lessons if row["lesson_id"] == route["selected"]), None
                    )
                    result["route"] = "reuse" if lesson else "generate"
                    if lesson is None and len(lessons) >= 16:
                        result["route"] = "registry_full"
                    elif lesson is None:
                        lesson = await build_lesson(
                            self, prefix + "/data", case, source, self.scope, embedded, lessons
                        )
                        if lesson is not None:
                            lessons.append(lesson)
                    result["lesson_id"] = None if lesson is None else lesson["lesson_id"]
                    if lesson is not None:
                        result["retry"] = await self.attempt(
                            prefix + "/retry", identity["config"], lesson
                        )
                    # Unknown or unfinished attempts never authorize a second paid
                    # attempt as though the prior attempt had received a zero.
                    retry = result["retry"]
                    if retry is None or retry["reward"] == 0:
                        result["fallback"] = await self.attempt(
                            prefix + "/fallback", identity["config"], None
                        )
                    if retry is not None and retry["reward"] == 1:
                        result.update(failure_state="resolved", resolved_by=lesson["lesson_id"])
                    elif result["fallback"] is not None and result["fallback"]["reward"] == 1:
                        result.update(failure_state="resolved", resolved_by="base")
                results.append(self.checkpoint(prefix + "/result", result))
                self.checkpoint(prefix + "/registry", lessons)
            return self.finish(results, lessons)

    def finish(self, episodes, lessons):
        records = {
            path.relative_to(self.root / "model").as_posix(): read_json(path)["receipt"]
            for path in (self.root / "model").rglob("*.json")
        }
        phases = {}
        for phase in ("generate", "validate", "retry", "fallback"):
            receipts = [
                row
                for path, row in records.items()
                if (
                    path.endswith("/" + phase + ".json")
                    if phase in ("generate", "validate")
                    else "/" + phase + "/" in path
                )
            ]
            phases[phase] = {"logical_calls": len(receipts), **token_usage(receipts)}
        source_usage = self.source_usage
        known = all(row.get("tokens") is not None for row in source_usage)
        return self.checkpoint(
            "result",
            {
                "schema_version": 1,
                "status": "completed",
                "adaptation": "procedural-context",
                "weights_updated": False,
                "effect_verified": False,
                "episodes": episodes,
                "lessons": lessons,
                "source_case_ids": self.source_case_ids,
                "imported_costs": None
                if self.previous is None
                else {
                    "previous_result_digest": self.previous_digest,
                    "model_usage": self.previous["model_usage"],
                    "source_collection_usage": self.previous["source_collection_usage"],
                    "imported_costs": self.previous["imported_costs"],
                },
                "model_usage": {
                    "logical_calls": len(records),
                    **token_usage(list(records.values())),
                },
                "phase_usage": phases,
                "source_collection_usage": {
                    "logical_calls": sum(row["completed_calls"] for row in source_usage),
                    "tokens": sum(row["tokens"] for row in source_usage) if known else None,
                },
                "cost_scope": "Logical model turns and reported tokens; CPU time, dollars and transport retries not estimated.",
            },
        )


async def replay_generated(root, source_root):
    """Re-execute native tools, checks and routing from saved model/embedding receipts."""
    root = Path(root).resolve()
    identity = read_json(root / "input.json")
    records = {
        path.relative_to(root / "model").with_suffix("").as_posix(): read_json(path)
        for path in (root / "model").rglob("*.json")
    }
    embeddings = {
        row["request"]["goal"]: row
        for path in (root / "embeddings").glob("*.json")
        for row in [read_json(path)]
    }
    seen, embedded = set(), set()

    async def call(key, prompt, harness, **settings):
        if key not in records:
            raise ValueError("missing completed Self-Direction request: " + key)
        saved = records[key]
        prepared = saved["input"]
        if (
            json.loads(prompt) != prepared["data"]
            or harness != prepared["prompt"]
            or settings != {**saved["settings"], "output_schema": prepared["schema"]}
        ):
            raise ValueError("saved Self-Direction request changed: " + key)
        seen.add(key)
        return saved["receipt"]

    def encode(text):
        row = embeddings[text]
        if row["request"]["embedding_identity"] != digest(identity["embedding"]):
            raise ValueError("saved lesson embedding identity changed")
        embedded.add(text)
        return {name: row[name] for name in ("vector", "tokens")}

    calls = SimpleNamespace(
        call=call,
        max_calls=identity["config"]["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
    )
    if identity["call_store"] is not None:
        calls.root = Path(identity["call_store"])
    with tempfile.TemporaryDirectory(prefix="gear-selfdirection-replay-") as directory:
        caller = RetailSelfDirection(
            directory,
            source_root,
            identity["config"],
            calls,
            SimpleNamespace(identity=identity["embedding"], encode=encode),
        )
        if caller.identity != identity:
            raise ValueError("Self-Direction runtime changed; use its frozen implementation")
        result = await caller.run()
        actual = {
            path.relative_to(directory).as_posix(): read_json(path)
            for path in Path(directory).rglob("*.json")
        }
        expected = {
            path.relative_to(root).as_posix(): read_json(path)
            for path in root.rglob("*.json")
            if "calls" not in path.relative_to(root).parts
        }
        changed = sorted(
            key for key in actual.keys() | expected.keys() if actual.get(key) != expected.get(key)
        )
        if (
            changed
            or seen != set(records)
            or embedded != set(embeddings)
            or result != read_json(root / "result.json")
        ):
            raise ValueError(
                "Self-Direction artifacts changed during replay: " + ", ".join(changed[:8])
            )
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Procedural lessons and native retail retries without GPU training"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--embedding-model", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--replay", action="store_true")
    args = parser.parse_args()
    config = read_json(args.input)

    async def run():
        if args.replay:
            if read_json(args.workspace / "input.json")["config"] != config:
                raise ValueError("Self-Direction replay requires the original configuration")
            return await replay_generated(args.workspace, args.tau2_source)
        if args.embedding_model is None:
            raise ValueError("supply the frozen local MiniLM directory")
        calls = TextCalls(args.workspace / "calls", max_calls=config["max_calls"], concurrency=1)
        caller = RetailSelfDirection(
            args.workspace, args.tau2_source, config, calls, MiniLM(args.embedding_model)
        )
        result = await caller.run(preflight=True)
        if args.preflight:
            return result
        async with calls:
            return await caller.run()

    print(json.dumps(asyncio.run(run()), ensure_ascii=False))


if __name__ == "__main__":
    main()
