"""Measure retail failure memory with explicit current-policy training probes.

The probe set is the union of original supporting tasks, not held-out tasks.
All execution, persistence and conversion remain in this concrete caller.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

from gear.canonical import digest
from gear.curriculum import ContrastiveDiagnoser, MergeFailureMemory
from ifeval_experiment import read_json
from model_calls import TextCalls, token_usage
from sentinel_collect import RetailCollector
from sentinel_generate import (
    authorized_cases,
    checked_history,
    freeze,
    implementation_identity,
    measured_mastery,
    probe_sample_id,
)
from sentinel_retail import RetailSession, calibrate, load_backend, validate_task


class RetailMastery:
    def __init__(self, root, source_root, config, calls):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        expected = {
            "schema_version",
            "partition",
            "family",
            "database",
            "user_id",
            "history",
            "tasks",
            "probe_id",
            "repetitions",
            "model",
            "effort",
            "harness",
            "max_steps",
            "max_calls",
        }
        if (
            set(config) != expected
            or type(config["schema_version"]) is not int
            or config["schema_version"] != 1
            or config["partition"] != "train"
        ):
            raise ValueError("retail mastery requires an explicit training-probe configuration")
        if any(
            not isinstance(config[key], str) or not config[key].strip()
            for key in ("family", "user_id", "probe_id", "model", "effort", "harness")
        ):
            raise ValueError("retail mastery scope, probe and policy settings must be nonempty")
        if any(
            type(config[key]) is not int or not 1 <= config[key] <= bound
            for key, bound in (("max_steps", 64), ("max_calls", 65536), ("repetitions", 16))
        ):
            raise ValueError("retail mastery requires bounded repetitions, steps and calls")
        if calls.max_calls != config["max_calls"]:
            raise ValueError("mastery caller quota differs from its predeclared shared budget")
        if not isinstance(config["tasks"], list) or not 1 <= len(config["tasks"]) <= 128:
            raise ValueError("retail mastery requires a bounded explicit probe task inventory")
        self.config = json.loads(json.dumps(config, allow_nan=False))
        config = self.config
        self.calls = calls
        self.backend = load_backend(source_root)
        session = RetailSession(self.backend, config["database"], config["user_id"])
        self.scope = {"environment_id": session.identity, "family": config["family"]}
        memory, cases = checked_history(
            config["history"],
            scope=self.scope,
            diagnoser_id=ContrastiveDiagnoser().identity,
        )
        if not memory:
            raise ValueError("mastery requires diagnosed failure memory")
        by_id = {case.case_id: case for case in cases}
        required_tasks = {
            by_id[key].record.task_id for mode in memory for key in mode.support_case_ids
        }
        bundles = {}
        for bundle in config["tasks"]:
            if set(bundle) != {"task", "reference", "evidence_refs"} or not bundle["evidence_refs"]:
                raise ValueError("probe tasks require caller-authorized source evidence")
            task = validate_task(bundle["task"], bundle["reference"])
            task_id = digest([task.model_dump(mode="json"), session.identity])
            if task_id in bundles or task_id not in required_tasks:
                raise ValueError("probe tasks must be distinct original supporting tasks")
            bundles[task_id] = bundle
        if set(bundles) != required_tasks:
            raise ValueError("mastery cannot omit a failure mode's supporting task")
        self.identity = {
            "config": config,
            "backend": self.backend["identity"],
            "implementation": implementation_identity(),
            "environment_id": session.identity,
            "model_calls_identity": getattr(calls, "identity", "TextCalls"),
            "call_store": str(Path(calls.root).resolve()) if hasattr(calls, "root") else None,
            "call_timeout_seconds": getattr(calls, "timeout_seconds", None),
            "call_delay_seconds": getattr(calls, "delay_seconds", 0),
        }
        freeze(self.root / "input.json", self.identity)
        self.schedule = []
        historical_samples = {case.record.sample_id for case in cases}
        # Calibrate every task before the first model submission; each trial owns
        # a disposable environment and its own stable logical sample identity.
        for task_id, bundle in sorted(bundles.items()):
            calibration = calibrate(
                self.backend,
                config["database"],
                config["user_id"],
                bundle["reference"],
                validate_task(bundle["task"], bundle["reference"]),
            )
            freeze(
                self.root / "calibration" / (task_id.removeprefix("sha256:") + ".json"), calibration
            )
            for repetition in range(config["repetitions"]):
                sample_id = probe_sample_id(config["probe_id"], task_id, repetition)
                if sample_id in historical_samples:
                    raise ValueError("probe_id was already measured; use a new ID for a new probe")

                async def scoped_call(key, prompt, harness, *, _sample=sample_id, **settings):
                    return await calls.call(_sample + "/" + key, prompt, harness, **settings)

                scoped = SimpleNamespace(
                    call=scoped_call,
                    max_calls=2 * config["max_steps"] + 1,
                    identity=getattr(calls, "identity", "TextCalls"),
                    timeout_seconds=getattr(calls, "timeout_seconds", None),
                    delay_seconds=getattr(calls, "delay_seconds", 0),
                )
                if hasattr(calls, "root"):
                    scoped.root = calls.root
                sample_config = {
                    **{
                        key: config[key]
                        for key in (
                            "schema_version",
                            "partition",
                            "family",
                            "database",
                            "user_id",
                            "model",
                            "effort",
                            "harness",
                            "max_steps",
                        )
                    },
                    "task": bundle["task"],
                    "reference": bundle["reference"],
                    "max_calls": scoped.max_calls,
                    "sample_id": sample_id,
                    "attempt": 0,
                }
                collector = RetailCollector(
                    self.root / "probes" / sample_id, source_root, sample_config, scoped
                )
                self.schedule.append((task_id, repetition, collector))
        policies = {collector.policy_id for _, _, collector in self.schedule}
        if len(policies) != 1:
            raise ValueError("mastery probes must use one frozen solver policy")
        self.policy_id = policies.pop()
        self.invalidated = [
            mode.mode_id
            for mode in memory
            if mode.mastery is not None and mode.mastery.policy_id != self.policy_id
        ]
        self.memory = tuple(
            replace(mode, state="active", mastery=None)
            if mode.mode_id in self.invalidated
            else mode
            for mode in memory
        )
        freeze(
            self.root / "plan.json",
            {
                "policy_id": self.policy_id,
                "probe_id": config["probe_id"],
                "repetitions": config["repetitions"],
                "tasks": sorted(required_tasks),
                "samples": [collector.config["sample_id"] for _, _, collector in self.schedule],
                "invalidated_prior_policy_measurements": self.invalidated,
                "max_calls": config["max_calls"],
            },
        )

    async def measure(self):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return await self._measure()

    async def _measure(self):
        probes, observations = [], []
        for task_id, repetition, collector in self.schedule:
            result = await collector.collect()
            observation = result["observation"]
            record = observation["record"]
            if record["task_id"] != task_id or record["policy_id"] != self.policy_id:
                raise ValueError("executed probe differs from its frozen task or policy")
            observations.append(observation)
            probes.append(
                {
                    "sample_id": record["sample_id"],
                    "task_id": task_id,
                    "repetition": repetition,
                    "result_ref": {
                        "path": str(collector.root / "result.json"),
                        "digest": digest(result),
                    },
                    "complete": record["complete"],
                    "passed": record["passed"],
                }
            )
        ledger = {
            digest(row): row for row in [*self.config["history"]["observations"], *observations]
        }
        all_observations = [ledger[key] for key in sorted(ledger)]
        cases, _ = authorized_cases(all_observations, **self.scope)
        measurements, inconclusive = [], []
        for mode in self.memory:
            observation = measured_mastery(
                mode,
                cases,
                probe_id=self.config["probe_id"],
                repetitions=self.config["repetitions"],
                policy_id=self.policy_id,
            )
            if observation is None:
                inconclusive.append(mode.mode_id)
            else:
                measurements.append(observation)
        memory = MergeFailureMemory()(self.memory, (), measurements=measurements)
        history = {
            "schema_version": 1,
            "scope": self.scope,
            "observations": all_observations,
            "memory": [asdict(mode) for mode in memory],
        }
        # The next generator uses this same conversion and evidence validation.
        checked_history(history, scope=self.scope, diagnoser_id=ContrastiveDiagnoser().identity)
        history = freeze(self.root / "memory.json", history)
        receipts = [
            read_json(path)["receipt"]
            for path in sorted(self.root.glob("probes/*/model/**/*.json"))
        ]
        return freeze(
            self.root / "result.json",
            {
                "schema_version": 1,
                "status": "inconclusive" if inconclusive else "measured",
                "policy_id": self.policy_id,
                "probes": probes,
                "measurements": [asdict(row) for row in measurements],
                "inconclusive": inconclusive,
                "invalidated_prior_policy_measurements": self.invalidated,
                "memory_ref": {"path": "memory.json", "digest": digest(history)},
                "model_usage": {
                    "completed_calls": len(receipts),
                    "tokens": token_usage(receipts).get("tokens"),
                    "call_limit": self.config["max_calls"],
                },
                "meaning": "Measured regression on declared supporting tasks under this policy; not general mastery.",
            },
        )


def main():
    parser = argparse.ArgumentParser(
        description="Measure retail failure memory without GPU training"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--tau2-source", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    config = read_json(args.input)

    async def run():
        calls = TextCalls(args.workspace / "calls", max_calls=config["max_calls"], concurrency=1)
        probe = RetailMastery(args.workspace, args.tau2_source, config, calls)
        if args.preflight:
            return {"status": "preflight", "planned_samples": len(probe.schedule), "model_calls": 0}
        async with calls:
            return await probe.measure()

    print(json.dumps(asyncio.run(run())))


if __name__ == "__main__":
    main()
