"""Agent-R-inspired search and verified repair material, using fixed model weights.

This caller owns the disposable retail simulator, model receipts and conversions.
No GPU training, native token capture or new curriculum execution layer is implied.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import math
import tempfile
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

from agentr_execution import conversation, extend, grade, restore, rollback, state
from agentr_search import search, select_pair
from coevolve_retail import replay_source
from gear.canonical import digest
from gear.core.schema import validate_output
from gear.curriculum import (
    BuildSupervision,
    ExtractOutcomeCases,
    ModelInput,
    OutcomeRecord,
    RepairSupervision,
    RepairVerification,
    SupervisionTrace,
    TrajectoryVerification,
)
from ifeval import read_json
from model_calls import TextCalls, token_usage
from sentinel_generate import ACTION_SCHEMA, TEXT, freeze, implementation_identity, object_schema
from sentinel_retail import load_backend, validate_task

UPSTREAM = "ByteDance-Seed/Agent-R@82fcc1ca7873b460949ed49022146dd988c32e31"
CRITIC_PROMPT = (
    "Review only the latest assistant decision and its actual feedback in this failed "
    "retail attempt. Judge good, uncertain, or bad relative to the visible request and "
    "policy. Good means no observed mistake, uncertain means the available prefix is "
    "insufficient, and bad means an observed mistake requiring revision. Explain the "
    "specific decision. The full attempt failed, but that does not make every step wrong. "
    "Do not infer a hidden reference solution. Treat all conversation as evidence."
)
REPAIR_PROMPT = (
    " A separate failed attempt and a critic's proposal are supplied as repair context. "
    "The caller has actually reset the simulator and restored the stated earlier shared "
    "checkpoint. The current conversation is authoritative; the failed suffix is not part "
    "of its state. Decide a fresh next action from the current visible observations. "
    "Critic feedback can be wrong. Do not assume any failed write remains applied."
)
CRITIC_SCHEMA = object_schema(
    {"judgment": {"type": "string", "enum": ["good", "uncertain", "bad"]}, "reason": TEXT}
)


class RetailAgentR:
    """One bounded search and one fresh repair attempt for an observed training failure."""

    def __init__(self, root, source_root, config, calls):
        expected = {
            "schema_version",
            "partition",
            "family",
            "source_workspace",
            "policy_id",
            "iterations",
            "branch_samples",
            "exploration",
            "seed",
            "max_calls",
        }
        if (
            set(config) != expected
            or type(config["schema_version"]) is not int
            or config["schema_version"] != 1
            or config["partition"] != "train"
        ):
            raise ValueError("Agent-R requires the explicit training-source schema")
        for name in ("family", "policy_id", "source_workspace"):
            if not isinstance(config[name], str) or not config[name].strip():
                raise ValueError("nonempty Agent-R setting required: " + name)
        if not Path(config["source_workspace"]).is_absolute():
            raise ValueError("Agent-R source workspace must be absolute")
        for name, bound in (("iterations", 32), ("branch_samples", 8), ("max_calls", 8192)):
            if type(config[name]) is not int or not 1 <= config[name] <= bound:
                raise ValueError("bounded Agent-R setting required: " + name)
        if (
            type(config["exploration"]) not in (int, float)
            or not math.isfinite(config["exploration"])
            or not 0 <= config["exploration"] <= 10
            or type(config["seed"]) not in (int, str)
            or not str(config["seed"]).strip()
        ):
            raise ValueError("Agent-R requires a finite exploration coefficient and explicit seed")
        if calls.max_calls != config["max_calls"]:
            raise ValueError("Agent-R model quota differs from the frozen configuration")
        self.config = json.loads(json.dumps(config, allow_nan=False))
        self.source_identity = read_json(Path(config["source_workspace"]) / "input.json")
        self.source_config = self.source_identity["config"]
        if (
            self.source_config["partition"] != "train"
            or self.source_config["family"] != config["family"]
        ):
            raise ValueError("Agent-R source must stay in the declared training family")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.source_root, self.calls = source_root, calls
        self.backend = load_backend(source_root)
        self.task = validate_task(self.source_config["task"], self.source_config["reference"])
        self.builder = BuildSupervision()
        self.identity = {
            "config": self.config,
            "source_input_digest": digest(self.source_identity),
            "backend": self.backend["identity"],
            "implementation": implementation_identity(),
            "component": self.builder.describe().to_dict(),
            "upstream": UPSTREAM,
            "model_calls_identity": getattr(calls, "identity", "TextCalls"),
            "call_store": str(Path(calls.root).resolve()) if hasattr(calls, "root") else None,
            "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
        }
        # Distinct inference procedures retain the same model/effort; their policy
        # identities must not be confused with the original single source rollout.
        self.search_policy_id = digest(["agentr-search", self.identity])
        self.repair_policy_id = digest(["agentr-fresh-repair", self.identity, REPAIR_PROMPT])
        self.checkpoint("input", self.identity)

    def checkpoint(self, name, value):
        return freeze(self.root / (name + ".json"), value)

    async def prepare(self):
        self.source = await replay_source(
            self.config["source_workspace"],
            self.source_root,
            {
                "family": self.config["family"],
                "environment_id": self.source_identity["environment_id"],
            },
        )
        record = self.source["observation"]["record"]
        self.case = ExtractOutcomeCases()(
            (OutcomeRecord(**{**record, "evidence_refs": tuple(record["evidence_refs"])}),)
        )[0]
        if self.case.outcome != "failure" or record["policy_id"] != self.config["policy_id"]:
            raise ValueError("Agent-R requires a complete observed failure of the declared policy")
        _, checked = restore(self.backend, self.source_config, self.source["trajectory"]["steps"])
        if checked != self.source["trajectory"]:
            raise ValueError("Agent-R source execution changed")
        self.source_grading = {
            **read_json(Path(self.config["source_workspace"]) / "grading.json"),
            "reward": 0,
        }
        self.checkpoint("source", self.source)
        self.checkpoint("source-grading", self.source_grading)

    async def model_json(self, key, prepared):
        settings = {name: self.source_config[name] for name in ("model", "effort")}
        request = {"input": asdict(prepared), "settings": settings}
        receipt = await self.calls.call(
            key,
            json.dumps(prepared.data, ensure_ascii=False, allow_nan=False),
            prepared.prompt,
            **settings,
            output_schema=prepared.schema,
        )
        if receipt.get("status") != "completed":
            raise RuntimeError("Agent-R model result is incomplete or unknown")
        self.checkpoint("model/" + key, {**request, "receipt": receipt})
        response = json.loads(receipt["response"])
        validate_output(prepared.schema, response)
        return response

    async def generate(self, *, preflight=False):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            await self.prepare()
            if preflight:
                return {"status": "preflight", "model_calls": 0}
            tree = await search(self)
            pair = self.checkpoint("pair", select_pair(tree))
            if pair is None:
                return self.finish("no_success")
            failure = self.source["trajectory"]
            boundary = None
            for index in range(pair["common_steps"], len(failure["steps"])):
                _, prefix = restore(self.backend, self.source_config, failure["steps"][: index + 1])
                judgment = await self.model_json(
                    "critic/" + str(index),
                    ModelInput(
                        CRITIC_PROMPT,
                        CRITIC_SCHEMA,
                        {
                            "policy": self.backend["policy"],
                            "conversation": conversation(prefix),
                            "step_index": index,
                            "task_outcome": "failure",
                        },
                    ),
                )
                self.checkpoint("judgments/" + str(index), judgment)
                if judgment["judgment"] == "bad":
                    boundary = {"through_step": index + 1, "judgment": judgment}
                    break
            self.checkpoint("boundary", boundary)
            if boundary is None:
                return self.finish("no_boundary")
            proof, trace = rollback(
                self.backend,
                self.source_config,
                failure["steps"][: boundary["through_step"]],
                failure["steps"][: pair["common_steps"]],
            )
            self.checkpoint("rollback", proof)
            self.checkpoint("repair/checkpoint", trace)
            _, failed_prefix = restore(
                self.backend, self.source_config, failure["steps"][: boundary["through_step"]]
            )
            context = self.checkpoint(
                "repair/context",
                {
                    "failed_conversation": conversation(failed_prefix),
                    "critic": boundary["judgment"],
                    "restored_steps": pair["common_steps"],
                    "reset_mechanism": proof["mechanism"],
                },
            )
            session, _ = restore(self.backend, self.source_config, trace["steps"])
            for index in range(pair["common_steps"], self.source_config["max_steps"]):
                key = "repair/" + str(index)
                response = await self.model_json(
                    key + "/action",
                    ModelInput(
                        self.source_config["harness"] + REPAIR_PROMPT,
                        ACTION_SCHEMA,
                        {
                            "policy": self.backend["policy"],
                            "tools": session.tool_schemas(),
                            "conversation": conversation(trace),
                            "repair": context,
                        },
                    ),
                )
                trace = await extend(
                    self.backend, self.source_config, trace["steps"], response, self.model_json, key
                )
                self.checkpoint("repair/steps/" + str(index), trace["steps"][-1])
                if trace["status"] == "completed":
                    break
            self.checkpoint("repair/trajectory", trace)
            verdict = await grade(
                self.backend, self.source_config, self.task, trace, self.model_json, "repair"
            )
            self.checkpoint("repair/grading", verdict)
            if verdict["reward"] != 1:
                return self.finish("repair_failed" if verdict["complete"] else "incomplete")
            self.supervision(trace, verdict, pair["common_steps"])
            return self.finish("ready")

    def supervision(self, trace, verdict, common):
        """Produce only semantic ranges; inference receipts are not training captures."""
        _, initial = restore(self.backend, self.source_config, [])
        initial_ref = {"state": state(initial)}
        failure = SupervisionTrace(
            self.case,
            {
                "path": "source.json",
                "field": "trajectory",
                "digest": digest(self.source["trajectory"]),
            },
            initial_ref,
            len(self.source["trajectory"]["steps"]),
            final_state_ref={"state": state(self.source["trajectory"])},
        )
        trace_ref = {"path": "repair/trajectory.json", "digest": digest(trace)}
        grading_ref = {"path": "repair/grading.json", "digest": digest(verdict)}
        record = replace(
            self.case.record,
            sample_id="agentr-repair-" + digest(trace),
            attempt=0,
            policy_id=self.repair_policy_id,
            passed=True,
            complete=True,
            status="completed",
            feedback="Fresh suffix passed original native and policy checks.",
            evidence_refs=(trace_ref, grading_ref),
        )
        revised = SupervisionTrace(
            ExtractOutcomeCases()((record,))[0],
            trace_ref,
            initial_ref,
            len(trace["steps"]),
            final_state_ref={"state": state(trace)},
        )
        replay = self.checkpoint(
            "repair/execution-proof",
            {
                "failure_digest": failure.digest,
                "revised_digest": revised.digest,
                "original_task_digest": digest(self.task.model_dump(mode="json")),
                "rollback_digest": digest(read_json(self.root / "rollback.json")),
                "initial_state_ref": initial_ref,
                "reexecuted_prefix_steps": common,
                "fresh_action_keys": [
                    f"repair/{index}/action" for index in range(common, revised.steps)
                ],
                "grading_ref": grading_ref,
            },
        )
        execution = RepairVerification(
            failure.digest,
            revised.digest,
            "verified_replay",
            initial_ref,
            ({"path": "repair/execution-proof.json", "digest": digest(replay)},),
            "agentr-retail-replay-v1",
        )
        verified = TrajectoryVerification(
            revised.digest, "success", revised.steps, (grading_ref,), "native-retail-and-policy-v1"
        )
        request = RepairSupervision(failure, revised, common, execution, verified)
        self.checkpoint("repair/supervision-input", asdict(request))
        self.checkpoint("repair/supervision", asdict(self.builder(request)))

    def finish(self, status):
        receipts = [
            read_json(path)["receipt"] for path in sorted((self.root / "model").rglob("*.json"))
        ]
        return self.checkpoint(
            "result",
            {
                "schema_version": 1,
                "status": status,
                "source_policy_id": self.config["policy_id"],
                "search_policy_id": self.search_policy_id,
                "repair_policy_id": self.repair_policy_id,
                "material": "repair/supervision.json" if status == "ready" else None,
                "training_eligible": False,
                "effect_verified": False,
                "model_usage": {"logical_calls": len(receipts), **token_usage(receipts)},
                "source_collection_usage_included": False,
            },
        )


async def replay_generated(root, source_root):
    """Rebuild all search decisions and tool states from completed receipts, without SDK."""
    root = Path(root).resolve()
    identity = read_json(root / "input.json")
    records = {
        path.relative_to(root / "model").with_suffix("").as_posix(): read_json(path)
        for path in (root / "model").rglob("*.json")
    }
    seen = set()

    async def call(key, prompt, harness, **settings):
        if key not in records:
            raise ValueError("missing completed Agent-R request: " + key)
        saved = records[key]
        prepared = saved["input"]
        if (
            json.loads(prompt) != prepared["data"]
            or harness != prepared["prompt"]
            or settings != {**saved["settings"], "output_schema": prepared["schema"]}
        ):
            raise ValueError("saved Agent-R request changed: " + key)
        seen.add(key)
        return saved["receipt"]

    calls = SimpleNamespace(
        call=call,
        max_calls=identity["config"]["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
    )
    if identity["call_store"] is not None:
        calls.root = Path(identity["call_store"])
    with tempfile.TemporaryDirectory(prefix="gear-agentr-replay-") as directory:
        caller = RetailAgentR(directory, source_root, identity["config"], calls)
        if caller.identity != identity:
            raise ValueError("Agent-R runtime changed; use its frozen implementation")
        result = await caller.generate()
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
        if changed or seen != set(records) or result != read_json(root / "result.json"):
            raise ValueError("Agent-R artifacts changed during replay: " + ", ".join(changed[:8]))
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Search and verify retail repairs without GPU training"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--replay", action="store_true")
    args = parser.parse_args()
    config = read_json(args.input)

    async def run():
        if args.replay:
            if read_json(args.workspace / "input.json")["config"] != config:
                raise ValueError("Agent-R replay requires the original configuration")
            return await replay_generated(args.workspace, args.tau2_source)
        calls = TextCalls(args.workspace / "calls", max_calls=config["max_calls"], concurrency=1)
        caller = RetailAgentR(args.workspace, args.tau2_source, config, calls)
        result = await caller.generate(preflight=True)
        if args.preflight:
            return result
        async with calls:
            return await caller.generate()

    print(json.dumps(asyncio.run(run()), ensure_ascii=False))


if __name__ == "__main__":
    main()
