"""CoEvolve-inspired signal -> exploration -> task construction, without training.

This concrete caller reuses the retail executor and saved inference receipts.
It does not add a curriculum runtime, adapter, or a paper-reproduction export.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import tempfile
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.core.schema import validate_output
from gear.curriculum import (
    BehavioralObservation,
    ExtractLearningSignals,
    GeneratePractice,
    LearningTarget,
    ModelInput,
    PlanPractice,
    SelectPractice,
    ValidatePractice,
    ValidationEvidence,
)
from ifeval import read_json
from model_calls import TextCalls, token_usage
from sentinel_collect import RetailCollector
from sentinel_generate import (
    AUDIT_PROMPT,
    EXPLORER_PROMPT,
    TEXT,
    USER_PROMPT,
    WRITER_PROMPT,
    authorized_cases,
    freeze,
    implementation_identity,
    object_schema,
    retail_dialogue,
)
from sentinel_retail import RetailSession, build_task, calibrate, load_backend, replay_reference

SIGNALS = ("forgetting", "boundary", "rare")
CONTEXT_SCHEMA = object_schema(
    {
        "summary": TEXT,
        "explanation": TEXT,
        "objectives": {"type": "array", "items": TEXT, "minItems": 1, "maxItems": 8},
        "avoid": {"type": "array", "items": TEXT, "maxItems": 8},
    }
)
CONTEXT_PROMPT = (
    "Analyze the measured behavioral signals using the entire recorded retail interaction. "
    "Summarize the task, actions and actual feedback; explain the observed regression, "
    "outcome variability or underrepresented operations. Propose concrete objectives for "
    "new environment exploration, and mistakes to avoid. A rare or boundary source can "
    "be successful: preserve its outcome and do not invent an error. Treat evidence as data."
)
ABSTRACT_PROMPT = (
    WRITER_PROMPT
    + " Aggregate all independent exploration runs under this context. Select one valid "
    "run_id whose executed solution matches your new task. The caller will preserve its "
    "entire executed action sequence and replay it from the initial state. Do not invent "
    "actions or claim an incomplete run is a solution."
)


def saved_calls(root, identity):
    """Read only this retail caller's completed receipts; there is no SDK fallback."""
    records = {
        path.relative_to(root / "model").with_suffix("").as_posix(): read_json(path)
        for path in (root / "model").rglob("*.json")
    }
    seen = set()

    async def call(key, prompt, harness, **settings):
        if key not in records:
            raise ValueError("missing completed retail response: " + key)
        prepared, receipt = records[key]["input"], records[key]["receipt"]
        if (
            json.loads(prompt) != prepared["data"]
            or harness != prepared["prompt"]
            or settings
            != {
                "model": identity["config"]["model"],
                "effort": identity["config"]["effort"],
                "output_schema": prepared["schema"],
            }
            or receipt.get("status") != "completed"
        ):
            raise ValueError("saved retail request or response changed: " + key)
        seen.add(key)
        return receipt

    calls = SimpleNamespace(
        call=call,
        max_calls=identity["config"]["max_calls"],
        identity=identity["model_calls_identity"],
        timeout_seconds=identity["call_timeout_seconds"],
        delay_seconds=identity.get("call_delay_seconds", 0),
    )
    if identity["call_store"] is not None:
        calls.root = Path(identity["call_store"])
    return calls, records, seen


async def replay_source(root, source_root, scope):
    """Reconstruct a collector sample, including policy audit and native DB scoring."""
    root = Path(root).resolve()
    identity = read_json(root / "input.json")
    config = identity["config"]
    if (
        config["partition"] != "train"
        or config["family"] != scope["family"]
        or identity["environment_id"] != scope["environment_id"]
    ):
        raise ValueError("CoEvolve history must stay inside the declared training scope")
    calls, records, seen = saved_calls(root, identity)
    with tempfile.TemporaryDirectory(prefix="gear-coevolve-source-") as directory:
        collector = RetailCollector(directory, source_root, config, calls)
        if collector.identity != identity:
            raise ValueError("source execution changed; use its frozen implementation")
        result = await collector.collect()
        # Only local artifact locations differ during replay. No evidence path
        # supplied by the source is dereferenced; the inventory below is fixed.
        for ref in result["observation"]["record"]["evidence_refs"]:
            ref["path"] = str(root / Path(ref["path"]).name)
        if result != read_json(root / "result.json") or seen != set(records):
            raise ValueError("source result or model receipt inventory changed")
        for name in ("trajectory", "grading", "calibration"):
            if read_json(Path(directory) / (name + ".json")) != read_json(root / (name + ".json")):
                raise ValueError("source native execution or grading changed: " + name)
    return {
        "observation": result["observation"],
        "trajectory": read_json(root / "trajectory.json"),
        "source": {
            "workspace": str(root),
            "input_digest": digest(identity),
            "result_digest": digest(result),
        },
    }


class RetailCoEvolve:
    """One bounded data-evolution trigger; history and search rounds are caller-owned."""

    def __init__(self, root, source_root, config, calls):
        expected = {
            "schema_version",
            "partition",
            "family",
            "database",
            "user_id",
            "history",
            "policy_id",
            "signals",
            "signal_config",
            "seed",
            "max_contexts",
            "exploration_runs",
            "max_steps",
            "max_calls",
            "model",
            "effort",
        }
        if (
            set(config) != expected
            or type(config["schema_version"]) is not int
            or config["schema_version"] != 1
            or config["partition"] != "train"
        ):
            raise ValueError("CoEvolve requires the explicit training-generation schema")
        for key in ("family", "user_id", "policy_id", "model", "effort"):
            if not isinstance(config[key], str) or not config[key].strip():
                raise ValueError("nonempty CoEvolve setting required: " + key)
        for key, bound in (
            ("max_contexts", 8),
            ("exploration_runs", 8),
            ("max_steps", 64),
            ("max_calls", 8192),
        ):
            if type(config[key]) is not int or not 1 <= config[key] <= bound:
                raise ValueError("bounded CoEvolve setting required: " + key)
        if calls.max_calls != config["max_calls"]:
            raise ValueError("model quota differs from the frozen generation budget")
        if type(config["seed"]) not in (int, str) or not str(config["seed"]).strip():
            raise ValueError("CoEvolve requires an explicit seed")
        if (
            not isinstance(config["signals"], list)
            or not config["signals"]
            or any(value not in SIGNALS for value in config["signals"])
            or len(set(config["signals"])) != len(config["signals"])
        ):
            raise ValueError("select distinct forgetting, boundary or rare signals")
        if (
            not isinstance(config["history"], list)
            or not 1 <= len(config["history"]) <= 256
            or any(
                not isinstance(row, dict)
                or set(row) != {"workspace", "iteration"}
                or not isinstance(row["workspace"], str)
                or not Path(row["workspace"]).is_absolute()
                or type(row["iteration"]) is not int
                or row["iteration"] < 0
                for row in config["history"]
            )
            or [row["iteration"] for row in config["history"]]
            != sorted(row["iteration"] for row in config["history"])
        ):
            raise ValueError("history requires chronological iterations and absolute workspaces")
        if not isinstance(config["signal_config"], dict) or set(config["signal_config"]) != {
            "history_window",
            "boundary_threshold",
            "rare_frequency",
            "minimum_patterns",
        }:
            raise ValueError("declare all behavioral signal thresholds")
        self.extractor = ExtractLearningSignals(**config["signal_config"])
        self.extractor((), policy_id=config["policy_id"])
        self.config = json.loads(json.dumps(config, allow_nan=False))
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.source_root = source_root
        self.backend = load_backend(source_root)
        self.session = RetailSession(self.backend, config["database"], config["user_id"])
        self.scope = {"family": config["family"], "environment_id": self.session.identity}
        self.calls = calls
        self.generator = GeneratePractice(prompt=ABSTRACT_PROMPT)
        self.validator = ValidatePractice("coevolve-retail-v1")
        self.identity = {
            "config": self.config,
            "backend": self.backend["identity"],
            "implementation": implementation_identity(),
            "components": [
                value.describe().to_dict()
                for value in (self.extractor, self.generator, self.validator)
            ],
            "environment_id": self.session.identity,
            "model_calls_identity": getattr(calls, "identity", "TextCalls"),
            "call_store": str(Path(calls.root).resolve()) if hasattr(calls, "root") else None,
            "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
        }
        freeze(self.root / "input.json", self.identity)

    def checkpoint(self, name, value):
        return freeze(self.root / (name + ".json"), value)

    async def model_json(self, key, prepared):
        receipt = await self.calls.call(
            key,
            json.dumps(prepared.data, ensure_ascii=False, allow_nan=False),
            prepared.prompt,
            model=self.config["model"],
            effort=self.config["effort"],
            output_schema=prepared.schema,
        )
        if receipt.get("status") != "completed":
            raise RuntimeError("CoEvolve model result is incomplete or unknown")
        self.checkpoint("model/" + key, {"input": asdict(prepared), "receipt": receipt})
        response = json.loads(receipt["response"])
        validate_output(prepared.schema, response)
        return response

    async def prepare(self):
        rows, samples, policies = [], {}, {}
        for entry in self.config["history"]:
            source = await replay_source(entry["workspace"], self.source_root, self.scope)
            record = source["observation"]["record"]
            sample = record["sample_id"]
            row = {**source, "iteration": entry["iteration"]}
            if sample in samples:
                if samples[sample] != row:
                    raise ValueError(
                        "a historical sample cannot be changed or assigned to another group"
                    )
                continue
            samples[sample] = row
            if policies.setdefault(entry["iteration"], record["policy_id"]) != record["policy_id"]:
                raise ValueError("each iteration must use one fixed solver policy")
            rows.append(row)
        if policies[max(policies)] != self.config["policy_id"]:
            raise ValueError("current policy must match the latest history iteration")
        cases, _ = authorized_cases([row["observation"] for row in rows], **self.scope)
        by_sample = {case.record.sample_id: case for case in cases}
        observations = tuple(
            BehavioralObservation(
                by_sample[row["observation"]["record"]["sample_id"]],
                # Task/environment identities are separate operator keys. This
                # binds the scoring protocol across fixed-weight harness versions.
                digest(["retail-binary-db-auth-policy-v1", self.backend["identity"]]),
                str(row["iteration"]),
                None
                if row["observation"]["record"]["passed"] is None
                else float(row["observation"]["record"]["passed"]),
                tuple(
                    sorted(
                        {
                            step["action"]["name"]
                            for step in row["trajectory"]["steps"]
                            if step["kind"] == "tool" and not step["execution"]["response"]["error"]
                        }
                    )
                ),
            )
            for row in rows
        )
        signals = self.extractor(observations, policy_id=self.config["policy_id"])
        # Past instances of the same harness inform history, but only the
        # explicitly current iteration supplies contexts for this trigger.
        current = {
            item.case.case_id for item in observations if item.group_id == str(max(policies))
        }
        signals = tuple(
            replace(
                item,
                signals=tuple(value for value in item.signals if value in self.config["signals"]),
                rare_patterns=item.rare_patterns if "rare" in self.config["signals"] else (),
            )
            for item in signals
            if item.case_id in current and set(item.signals) & set(self.config["signals"])
        )
        rng = DeterministicRandom(str(self.config["seed"]))
        selected = sorted(signals, key=lambda item: (rng.value(item.case_id, 0), item.case_id))[
            : self.config["max_contexts"]
        ]
        self.checkpoint("history", rows)
        self.checkpoint(
            "signals",
            {
                "observations": [asdict(item) for item in observations],
                "eligible": [asdict(item) for item in signals],
                "selected": [asdict(item) for item in selected],
                "pattern_definition": "distinct successful native tool names per trajectory",
            },
        )
        self.cases = cases
        self.sources = {
            by_sample[row["observation"]["record"]["sample_id"]].case_id: row for row in rows
        }
        return selected

    async def generate(self, *, preflight=False):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            signals = await self.prepare()
            if preflight:
                return {"status": "preflight", "contexts": len(signals), "model_calls": 0}
            results = []
            comparisons = [case.record.instruction for case in self.cases]
            for index, signal in enumerate(signals):
                result = await self.construct(index, signal, comparisons)
                results.append(result)
                if result["status"] == "ready":
                    comparisons.append(result["draft"]["instruction"])
            receipts = [
                read_json(path)["receipt"] for path in sorted((self.root / "model").rglob("*.json"))
            ]
            selected = [row["draft"]["draft_id"] for row in results if row["status"] == "ready"]
            return self.checkpoint(
                "result",
                {
                    "schema_version": 1,
                    "status": "ready" if selected else "no_signals" if not signals else "rejected",
                    "candidates": results,
                    "selected": selected,
                    "environment_id": self.session.identity,
                    "training_eligible": False,
                    "model_usage": {
                        "completed_calls": len(receipts),
                        "tokens": token_usage(receipts).get("tokens"),
                        "call_limit": self.config["max_calls"],
                    },
                },
            )

    async def construct(self, index, signal, comparisons):
        prefix = f"contexts/{index}"
        signal_data = self.checkpoint(prefix + "/signal", asdict(signal))
        source = self.sources[signal.case_id]
        context = await self.model_json(
            prefix + "/summarize",
            ModelInput(
                CONTEXT_PROMPT,
                CONTEXT_SCHEMA,
                {
                    "signal": asdict(signal),
                    "source": source["observation"],
                    "trajectory": source["trajectory"],
                },
            ),
        )
        target = LearningTarget(
            digest([signal_data, context]),
            json.dumps({"signals": signal.signals, "context": context}, ensure_ascii=False),
            1,
            (signal.case_id,),
            (self.config["family"],),
        )
        plan = PlanPractice(self.generator.identity, self.validator.identity, "signal")((target,))[
            0
        ]
        self.checkpoint(prefix + "/plan", asdict(plan))
        runs = []
        for repetition in range(self.config["exploration_runs"]):
            run_id = f"run-{repetition}"
            run_prefix = prefix + "/" + run_id
            session = RetailSession(self.backend, self.config["database"], self.config["user_id"])

            async def call(key, prepared):
                if key.startswith("explore/"):
                    prepared = replace(
                        prepared,
                        data={
                            **prepared.data,
                            "exploration_context": context,
                            "signals": list(signal.signals),
                        },
                    )
                return await self.model_json(run_prefix + "/" + key, prepared)

            goal = await call(
                "goal",
                ModelInput(
                    "Choose a feasible new retail customer goal that exercises the exploration "
                    "context and changes the database. Use customer constraints, no procedural solution.",
                    object_schema({"goal": TEXT}),
                    {
                        "context": context,
                        "signals": list(signal.signals),
                        "customer": session.user_material(),
                        "products": session.initial["products"],
                        "policy": self.backend["policy"],
                        "run_id": run_id,
                    },
                ),
            )
            opening = await call(
                "user/0",
                ModelInput(
                    USER_PROMPT,
                    object_schema({"message": TEXT}),
                    {"goal": goal["goal"], "customer": session.user_material(), "conversation": []},
                ),
            )
            trace = await retail_dialogue(
                session,
                call,
                lambda name, value: self.checkpoint(run_prefix + "/" + name, value),
                opening=opening["message"],
                goal=goal["goal"],
                harness=EXPLORER_PROMPT,
                max_steps=self.config["max_steps"],
                role="explore",
            )
            self.checkpoint(run_prefix + "/trajectory", trace)
            try:
                replay_reference(
                    self.backend, self.config["database"], self.config["user_id"], trace
                )
                if sum(step["kind"] == "tool" for step in trace["steps"]) < 3:
                    raise ValueError(
                        "task abstraction requires at least three executed tool actions"
                    )
                status, reason = "valid", ""
            except ValueError as error:
                status, reason = "invalid_reference", str(error)
            runs.append({"run_id": run_id, "status": status, "reason": reason, "trajectory": trace})
        self.checkpoint(prefix + "/explorations", runs)
        valid = {row["run_id"]: row["trajectory"] for row in runs if row["status"] == "valid"}
        if not valid:
            return {"status": "invalid_references", "context": index, "signal": asdict(signal)}
        writer = self.generator.prepare(plan, cases=self.cases)
        written = await self.model_json(
            prefix + "/abstract",
            replace(
                writer,
                schema=object_schema(
                    {
                        "instruction": TEXT,
                        "user_instructions": TEXT,
                        "run_id": {"type": "string", "enum": list(valid)},
                    }
                ),
                data={**writer.data, "context": context, "explorations": runs},
            ),
        )
        trace = valid[written["run_id"]]
        self.checkpoint(prefix + "/reference", trace)
        drafts = self.generator.parse(
            {
                "practices": [
                    {
                        "instruction": written["instruction"],
                        "family": self.config["family"],
                        "data": {
                            "environment_id": self.session.identity,
                            "user_id": self.config["user_id"],
                            "user_instructions": written["user_instructions"],
                        },
                        "reference": {"trace_digest": digest(trace), "run_id": written["run_id"]},
                        "verifier": {"kind": "tau2-retail-db", "backend": self.backend["identity"]},
                    }
                ]
            },
            plan=plan,
        )
        draft = drafts[0]
        task = build_task(draft, trace)
        calibration = calibrate(
            self.backend, self.config["database"], self.config["user_id"], trace, task
        )
        self.checkpoint(prefix + "/calibration", calibration)
        audit = await self.model_json(
            prefix + "/audit",
            ModelInput(
                AUDIT_PROMPT + " Also assess novel: the request adds a different customer goal or "
                "constraints to the comparison requests, rather than only paraphrasing them. "
                "The reference must achieve the entire generated request. A successful signal "
                "source is legitimate and must not be described as a failure.",
                object_schema(
                    {
                        **{
                            key: {"type": "boolean"}
                            for key in (
                                "valid",
                                "faithful",
                                "policy_compliant",
                                "hides_solution",
                                "novel",
                            )
                        },
                        "reason": TEXT,
                    }
                ),
                {
                    "directive": asdict(plan.target),
                    "draft": asdict(draft),
                    "reference": trace,
                    "policy": self.backend["policy"],
                    "comparison_requests": comparisons,
                },
            ),
        )
        validation = self.validator.plan(drafts)
        verdicts = {
            "environment": (True, "execution", {"environment_id": self.session.identity}),
            "reference": (True, "execution", {"trace_digest": digest(trace)}),
            "verifier_calibration": (True, "execution", calibration),
            "target_fidelity": (
                all(
                    audit[key]
                    for key in ("valid", "faithful", "policy_compliant", "hides_solution")
                ),
                "semantic",
                audit,
            ),
            "novelty": (
                audit["novel"]
                and draft.instruction.strip() not in {text.strip() for text in comparisons},
                "semantic",
                {
                    "exact_duplicate": draft.instruction.strip()
                    in {text.strip() for text in comparisons},
                    "semantic": audit["novel"],
                    "comparison_digest": digest(comparisons),
                },
            ),
        }
        values = self.checkpoint(
            prefix + "/validation-evidence", {key: value[2] for key, value in verdicts.items()}
        )
        evidence = tuple(
            ValidationEvidence(
                draft.draft_id,
                draft.digest,
                validation.policy_id,
                validation.validator_id,
                check,
                passed,
                kind,
                (
                    {
                        "path": prefix + "/validation-evidence.json",
                        "check": check,
                        "digest": digest(values),
                    },
                ),
            )
            for check, (passed, kind, _) in verdicts.items()
        )
        report = self.validator.assess(validation, evidence)
        pool = SelectPractice()(drafts, report, budget=1, base_pool_version=digest(comparisons))
        return self.checkpoint(
            prefix + "/result",
            {
                "status": "ready" if pool.selections else "rejected",
                "context": index,
                "signal": asdict(signal),
                "draft": asdict(draft),
                "report": asdict(report),
                "pool": asdict(pool),
                "task": task.model_dump(mode="json"),
                "reference_path": prefix + "/reference.json",
                "reference_digest": digest(trace),
            },
        )


async def replay_generated(root, source_root, draft_id):
    """Rebuild the entire trigger offline before exporting a selected native task."""
    root = Path(root).resolve()
    identity = read_json(root / "input.json")
    calls, records, seen = saved_calls(root, identity)
    with tempfile.TemporaryDirectory(prefix="gear-coevolve-check-") as directory:
        generator = RetailCoEvolve(directory, source_root, identity["config"], calls)
        if generator.identity != identity:
            raise ValueError("CoEvolve runtime changed; use its frozen implementation")
        result = await generator.generate()
        if result != read_json(root / "result.json") or seen != set(records):
            raise ValueError("CoEvolve result or model receipt inventory changed")
        for name in ("history.json", "signals.json"):
            if read_json(Path(directory) / name) != read_json(root / name):
                raise ValueError("CoEvolve history or selection changed")
        # Validate the whole generated artifact inventory, including rejected runs.
        actual = {
            path.relative_to(Path(directory) / "contexts"): read_json(path)
            for path in (Path(directory) / "contexts").rglob("*.json")
        }
        expected = {
            path.relative_to(root / "contexts"): read_json(path)
            for path in (root / "contexts").rglob("*.json")
        }
        if actual != expected:
            raise ValueError("CoEvolve exploration or validation evidence changed")
    if draft_id not in result["selected"]:
        raise ValueError("CoEvolve task did not pass all validation checks")
    candidate = next(
        row for row in result["candidates"] if row.get("draft", {}).get("draft_id") == draft_id
    )
    config = identity["config"]
    return {
        **{key: config[key] for key in ("partition", "family", "database", "user_id")},
        "task": candidate["task"],
        "reference": read_json(root / candidate["reference_path"]),
        "provenance": {
            "kind": "generated",
            "recipe": "coevolve-retail-v1",
            "workspace": str(root),
            "input_digest": digest(identity),
            "result_digest": digest(result),
            "draft_id": draft_id,
        },
    }


def main():
    parser = argparse.ArgumentParser(
        description="Explore and construct retail tasks from measured signals; no GPU"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    config = read_json(args.input)

    async def run():
        # Construction and history validation happen before opening an SDK client.
        calls = TextCalls(args.workspace / "calls", max_calls=config["max_calls"], concurrency=1)
        generator = RetailCoEvolve(args.workspace, args.tau2_source, config, calls)
        result = await generator.generate(preflight=True)
        if not args.preflight:
            async with calls:
                result = await generator.generate()
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in ("status", "contexts", "model_calls", "selected", "model_usage")
                    if key in result
                },
                ensure_ascii=False,
            )
        )

    asyncio.run(run())


if __name__ == "__main__":
    main()
