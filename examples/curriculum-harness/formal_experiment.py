"""Four-arm, multi-seed caller experiment using the public Project.refine API.

All generated pools enter a new admitted run. Training feedback is separated
from candidate selection, and the final test is opened only after valid search.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import random
import shlex
import sys
from collections import Counter
from dataclasses import asdict
from pathlib import Path

from gear import Project
from gear.algorithms import ReflectiveSearch
from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.core.schema import validate_output
from gear.curriculum import (
    ContrastiveDiagnoser,
    GeneratePractice,
    LearningTarget,
    MasteryObservation,
    MergeFailureMemory,
    PlanPractice,
    SelectLearningTargets,
    ValidatePractice,
)
from gear.search import PromptConstraints
from ifeval_experiment import (
    GENERATION_PROMPT,
    INITIAL_HARNESS,
    SOURCE_COMMIT,
    Benchmark,
    Experiment,
    json_data,
    paired_comparison,
    read_json,
    write_json,
)
from model_calls import TextCalls

ARMS = ("fixed", "random", "failure", "memory")
MUTATIONS = (
    "Use a new topic while preserving the observed failing constraint interaction.",
    "Create a harder boundary instance of the same fixed constraint template.",
    "Rephrase the topical request with distracting but relevant content; preserve all constraints.",
    "Create a minimal targeted exercise of the same failing capability on a new topic.",
)


class ModelResponseError(ValueError):
    """A completed model response failed its declared JSON contract."""


def freeze(path, value):
    value = json_data(value)
    if path.exists() and read_json(path) != value:
        raise ValueError("frozen experiment input changed: " + str(path))
    write_json(path, value)


def fresh_splits(benchmark, previous, config):
    # All previously used source families are excluded, including pilot train/dev.
    excluded = {
        task["id"] for split in ("train", "dev", "test") for task in previous[split]
    } | set(previous.get("excluded_ids", ()))
    all_rows = benchmark.split(config["split_seed"], 0, 0, 0)
    eligible = benchmark.split(config["split_seed"], all_rows["eligible_count"], 0, 0)[
        "train"
    ]
    remaining = [task for task in eligible if task["id"] not in excluded]
    n, d, t = (config[key] for key in ("train_count", "dev_count", "test_count"))
    if len(remaining) < n + d + t:
        raise ValueError("not enough previously untouched source families")
    return {
        "excluded_ids": sorted(excluded),
        "train": remaining[:n],
        "dev": remaining[n : n + d],
        "test": remaining[n + d : n + d + t],
    }


class Study:
    # Reuse the pilot's audited case conversion and official-verifier validation.
    # These methods have no model/runtime calls and remain frozen in study identity.
    cases = Experiment.cases
    validate = Experiment.validate

    def task_from_draft(self, draft, slots):
        task = Experiment.task_from_draft(self, draft, slots)
        return {
            **task,
            "id": "practice-" + draft.draft_id.removeprefix("sha256:"),
            "curriculum_draft_id": draft.draft_id,
        }

    def __init__(self, root, benchmark, previous, config):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.benchmark, self.config = benchmark, config
        self.splits = fresh_splits(benchmark, previous, config)
        self.templates = {task["id"]: task for task in self.splits["train"]}
        self.generator = GeneratePractice(GENERATION_PROMPT)
        self.diagnoser = ContrastiveDiagnoser(max_modes=2)
        self.selector = SelectLearningTargets(max_targets=2)
        self.validator = ValidatePractice("ifeval-strict-" + SOURCE_COMMIT)
        here = Path(__file__).resolve().parent
        sources = [
            here / name
            for name in (
                "formal_experiment.py",
                "formal_provider.py",
                "model_calls.py",
                "ifeval_experiment.py",
            )
        ]
        sources += list((here.parents[1] / "python/gear/curriculum").glob("*.py"))
        sources += [
            here.parents[1] / "python/gear/algorithms" / name
            for name in (
                "reflective_search.py",
                "opro.py",
            )
        ]
        sources += [here.parents[1] / "python/gear/search/constraints.py"]
        self.identity = {
            "config": config,
            "source": benchmark.manifest,
            "verifier_resources": benchmark.resource_identity,
            "verifier_policy": benchmark.verifier_policy,
            "implementation": {
                str(p.relative_to(here.parents[1])): hashlib.sha256(
                    p.read_bytes()
                ).hexdigest()
                for p in sources
            },
            "splits": self.splits,
            "quota_unit": "logical SDK turns; native HTTP retries are unbounded and uncounted",
            "randomness": "seeds control task sampling and arm order; provider exposes no sampling seed",
        }
        freeze(self.root / "identity.json", self.identity)
        freeze(self.root / "splits.json", self.splits)
        self.calls = None
        self.memory = {arm: () for arm in ARMS}
        self.case_banks = {arm: {} for arm in ARMS}

    def event(self, **data):
        print(json.dumps(data, ensure_ascii=False), flush=True)

    async def evaluate(self, key, harness, tasks):
        async def one(task):
            call_key = key + "/" + task["id"]
            receipt = await self.calls.call(
                call_key,
                task["prompt"],
                harness,
                model=self.config["student"],
                effort=self.config["effort"],
            )
            return {
                "task": task,
                "response": receipt["response"],
                "call_key": call_key,
                "policy_id": digest(harness),
                **self.benchmark.grade(task, receipt["response"]),
            }

        rows = await asyncio.gather(*(one(task) for task in tasks))
        freeze(self.root / "evaluations" / (key.replace("/", "_") + ".json"), rows)
        self.event(
            event="evaluate",
            key=key,
            passed=sum(r["passed"] for r in rows),
            total=len(rows),
        )
        return rows

    async def model_json(self, key, model_input):
        prompt = (
            model_input.prompt
            + "\nResponse schema:\n"
            + json.dumps(model_input.schema)
            + "\nInput:\n"
            + json.dumps(model_input.data)
        )
        receipt = await self.calls.call(
            key,
            prompt,
            "Return only the requested JSON. Do not use tools.",
            model=self.config["teacher"],
            effort=self.config["effort"],
            output_schema=model_input.schema
            if self.config.get("structured_output", False)
            else None,
        )
        try:
            response = json.loads(receipt["response"])
            validate_output(model_input.schema, response)
        except ValueError as error:
            raise ModelResponseError(str(error)) from error
        return response

    async def generate(self, seed, arm, round_index, rows, used):
        count = self.config["learning_count"]
        if arm == "fixed":
            pool = list(self.splits["train"])
            random.Random(seed).shuffle(pool)
            return pool[:count]
        cases = self.cases(rows)
        self.case_banks[arm].update({case.case_id: case for case in cases})
        memory = self.memory[arm] if arm == "memory" else ()
        delta = ()
        prefix = f"seed-{seed}/{arm}/round-{round_index}"
        if arm != "random" and any(case.outcome == "failure" for case in cases):
            prepared = self.diagnoser.prepare(cases, memory=memory)
            response = await self.model_json(prefix + "/diagnose", prepared)
            delta = self.diagnoser.parse(response, cases=cases)
        memory = MergeFailureMemory()(memory, delta)
        if arm == "memory":
            # Current-policy measurements retire/reopen modes; history alone is not mastery.
            observations = []
            for mode in memory:
                measured = [
                    row for row in rows if row["task"]["family"] in mode.families
                ]
                if measured:
                    observations.append(
                        MasteryObservation(
                            mode.mode_id,
                            all(row["passed"] for row in measured),
                            measured[0]["policy_id"],
                            tuple(row["call_key"] for row in measured),
                        )
                    )
            memory = MergeFailureMemory()(memory, (), measurements=observations)
            self.memory[arm] = memory
        targeted_count = count - 2 if arm == "memory" else count
        targets = (
            self.selector(memory, budget=targeted_count) if arm != "random" else ()
        )
        plans = []
        for target in targets:
            mutation = (
                MUTATIONS[(seed + round_index) % len(MUTATIONS)]
                if arm == "memory"
                else "Create new instances exercising the target capability."
            )
            plans.extend(
                PlanPractice(
                    self.generator.identity,
                    self.validator.identity,
                    "failure",
                    mutation,
                )((target,))
            )
        # Exploration is predeclared; lack of failures is an explicitly logged fallback.
        random_count = count if not targets else (1 if arm == "memory" else 0)
        if random_count:
            random_target = LearningTarget(
                "random-domain",
                "Uniformly sampled training constraint templates",
                random_count,
                (),
                tuple(sorted(task["family"] for task in self.templates.values())),
            )
            plans.extend(
                PlanPractice(
                    self.generator.identity, self.validator.identity, "random"
                )((random_target,))
            )
        bank = tuple(self.case_banks[arm].values()) if arm == "memory" else cases
        tasks, reports = [], []
        for plan in plans:
            templates = sorted(
                (
                    task
                    for task in self.templates.values()
                    if task["family"] in plan.target.families
                ),
                key=lambda task: task["id"],
            )
            rng = DeterministicRandom(
                f"{seed}/{arm}/{round_index}/{plan.target.target_id}"
            )
            slots = []
            for i in range(plan.target.count):
                source = templates[int(rng.value("template", i) * len(templates))]
                slots.append(
                    {
                        "slot": i,
                        "source_task_id": source["id"],
                        "family": source["family"],
                        "constraints": self.benchmark.descriptions(source),
                    }
                )
            prepared = self.generator.prepare(plan, cases=bank)
            prepared.data["slots"] = slots
            if self.config.get("structured_output", False):
                # The caller knows the IFEval payload shape. Tighten the generic
                # operator schema here for native structured generation.
                properties = prepared.schema["properties"]["practices"]["items"][
                    "properties"
                ]
                source_ids = sorted({slot["source_task_id"] for slot in slots})
                properties["data"] = {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["slot", "source_task_id"],
                    "properties": {
                        "slot": {"type": "integer", "enum": list(range(len(slots)))},
                        "source_task_id": {"type": "string", "enum": source_ids},
                    },
                }
                properties["reference"] = {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["answer"],
                    "properties": {"answer": {"type": "string"}},
                }
                properties["verifier"] = {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["source_task_id"],
                    "properties": {
                        "source_task_id": {"type": "string", "enum": source_ids}
                    },
                }
            response = await self.model_json(
                prefix + "/generate/" + plan.target.target_id, prepared
            )
            drafts = self.generator.parse(response, plan=plan)
            selected, report = self.validate(
                drafts, slots, used | {task["prompt"] for task in tasks}
            )
            tasks.extend(selected)
            for task in selected:
                task["curriculum_conditioning"] = plan.conditioning
            reports.append({"plan": asdict(plan), "slots": slots, **report})
        if arm == "memory" and targets:
            # Preserve at least one validated exploration item before any
            # cross-arm shortfall reduces the common pool size.
            tasks.sort(key=lambda task: task["curriculum_conditioning"] != "random")
            tasks.insert(
                0,
                self.splits["train"][(seed + round_index) % len(self.splits["train"])],
            )
        freeze(
            self.root / prefix / "generation.json",
            {
                "tasks": tasks,
                "reports": reports,
                "memory": [asdict(mode) for mode in self.memory[arm]],
                "conditioning": "failure" if targets else "random",
            },
        )
        self.event(
            event="generated", seed=seed, arm=arm, round=round_index, valid=len(tasks)
        )
        return tasks

    async def search(
        self,
        seed,
        arm,
        round_index,
        harness,
        tasks,
        *,
        preflight=False,
        training_gate=False,
        provider_script=None,
    ):
        directory = (
            self.root / f"seed-{seed}" / arm / f"round-{round_index}" / "project"
        )
        directory.mkdir(parents=True, exist_ok=True)
        for folder in ("extensions", "skills", "prompts"):
            (directory / "target/.pi" / folder).mkdir(parents=True, exist_ok=True)
        freeze(directory / "target/.pi/settings.json", {})
        path = directory / "target/AGENTS.md"
        if path.exists() and path.read_text() != harness:
            raise ValueError("project initial harness changed")
        path.write_text(harness)
        freeze(
            directory / "gear.yaml",
            {
                "version": 1,
                "benchmark": "./benchmark.yaml",
                "target": {
                    "adapter": "pi",
                    "path": "./target",
                    "profile": "study-target",
                },
                "meta": {"profile": "study-meta"},
                "algorithm": "opro",
                "objective": {"metric": "pass_rate"},
                "validation": {"mode": "holdout"},
                "budget": {
                    "rounds": 1,
                    "max_candidates": 2,
                    "repetitions": 1,
                    "max_evaluations": len(tasks) * (2 if training_gate else 1)
                    + 2 * len(self.splits["dev"]),
                },
                "evaluation": {
                    "repair": {
                        "max_retries": 0,
                        "max_projections": 0,
                        "backoff_ms": [0],
                    }
                },
            },
        )
        freeze(
            directory / "benchmark.yaml",
            {"version": 1, "source": "./tasks.jsonl", "template": "text"},
        )
        # `expected` is a frozen IFEval verifier descriptor interpreted by this
        # explicit provider. It is never sent to the target or used as an answer.
        admitted = [(task, "seed") for task in [*tasks, *self.splits["dev"]]] + [
            (task, "held_out") for task in self.splits["test"]
        ]
        rows = [
            {
                "id": task["id"],
                "instruction": task["prompt"],
                "expected": json.dumps(task),
                "family": task["family"],
                "split": split,
            }
            for task, split in admitted
        ]
        source = "".join(json.dumps(row) + "\n" for row in rows)
        path = directory / "tasks.jsonl"
        if path.exists() and path.read_text() != source:
            raise ValueError("admitted pool changed")
        path.write_text(source)
        project = Project.open(directory)
        provider_script = Path(
            provider_script or Path(__file__).with_name("formal_provider.py")
        ).resolve()
        freeze(
            directory.parent / "provider.json",
            {
                "path": str(provider_script),
                "sha256": hashlib.sha256(provider_script.read_bytes()).hexdigest(),
            },
        )
        profile_root = Path(os.environ["GEAR_PROFILE_ROOT"])
        profile_root.mkdir(parents=True, exist_ok=True)
        launcher = profile_root / "provider-launcher.sh"
        launch = (
            "#!/bin/sh\nexec "
            + shlex.join(
                [
                    sys.executable,
                    str(provider_script),
                ]
            )
            + "\n"
        )
        if launcher.exists() and launcher.read_text() != launch:
            raise ValueError("provider interpreter or launcher changed")
        launcher.write_text(launch)
        for role, model in (
            ("target", self.config["student"]),
            ("meta", self.config["teacher"]),
        ):
            profile = {
                # Process profiles canonicalize command[0] with realpath. Keep
                # the venv interpreter argv intact rather than resolving it to
                # a system Python with a different installed package set.
                "command": ["/bin/sh", str(launcher)],
                "workingDirectory": str(Path(__file__).resolve().parents[2]),
                "passEnv": ["PYTHONPATH", "NLTK_DATA"],
                "timeoutMs": 600000,
                "configuration": {
                    "calls": str(self.root / "calls"),
                    "receipts": str(self.root / "operations"),
                    "max_calls": self.config["max_calls"],
                    "model": model,
                    "effort": self.config["effort"],
                    "ifeval_root": str(self.benchmark.root),
                    "language_seed": self.benchmark.verifier_policy.get(
                        "language_detection_seed", 0
                    ),
                    "structured_output": self.config.get("structured_output", False),
                },
            }
            profile_path = profile_root / f"study-{role}.json"
            if profile_path.exists():
                if read_json(profile_path) != profile:
                    raise ValueError("study profile changed")
            else:
                await project.acreate_profile("study-" + role, profile)
        algorithm = ReflectiveSearch(
            tuple(task["id"] for task in tasks),
            tuple(task["id"] for task in self.splits["dev"]),
            constraints=PromptConstraints(1800),
            target_characters=1000,
            max_repairs=2,
            nominate=False,
            training_gate=training_gate,
        )
        if preflight:
            await project.acheck()
            return await project.aplan_refine(algorithm=algorithm, rounds=1)
        # A project has exactly one admitted run. After an interrupted CLI reply,
        # recover its original journal instead of creating another paid run.
        journals = list((directory / ".gear/runs").glob("*/journal.json"))
        if len(journals) > 1:
            raise ValueError("ambiguous outer-loop run")
        if journals:
            run_id = journals[0].parent.name
            report = (await project.areport(run_id)).summary
            if report["status"] != "completed":
                report = (await project.aresume(run_id)).report.summary
        else:
            result = await project.arefine(algorithm=algorithm, rounds=1)
            run_id, report = result.id, result.report.summary
        if report["status"] != "completed" or report["nominee"] is not None:
            raise RuntimeError(
                "formal search did not complete without final-test nomination"
            )
        selected = report["operators"]["outcome"]["selected"]
        run_root = directory / ".gear/runs" / run_id
        journal = read_json(run_root / "journal.json")
        if (
            digest({key: val for key, val in journal.items() if key != "digest"})
            != journal["digest"]
        ):
            raise ValueError("search journal changed")
        candidate = run_root / "targets" / selected["candidate_id"]
        manifest = read_json(
            run_root / "target-manifests" / (selected["candidate_id"] + ".json")
        )
        if (
            manifest["digest"] != selected["digest"]
            or digest({k: v for k, v in manifest.items() if k != "digest"})
            != selected["digest"]
        ):
            raise ValueError("selected candidate manifest changed")
        text = (candidate / "AGENTS.md").read_text()
        resource = next(
            item for item in manifest["resources"] if item["path"] == "AGENTS.md"
        )
        if resource["digest"] != digest(base64.b64encode(text.encode()).decode()):
            raise ValueError("selected prompt differs from sealed bytes")
        records = [
            record
            for step in journal["operators"]["decisions"]
            for record in step["decision"]["records"]
        ]
        constraints = [
            record for record in records if record["kind"] == "prompt_constraints"
        ]
        result = {
            "run_id": run_id,
            "selected": selected,
            "harness": text,
            "valid_candidate": any(
                record["status"] == "allow" for record in constraints
            ),
            "constraints": constraints,
            "outcome": report["operators"]["outcome"],
            "physical_attempts": journal["physicalAttempts"],
        }
        freeze(directory.parent / "search.json", result)
        self.event(
            event="search",
            seed=seed,
            arm=arm,
            round=round_index,
            valid=result["valid_candidate"],
            changed=text != harness,
        )
        return result

    async def run(self, phase):
        if phase == "preflight":
            report = await self.search(
                0,
                "fixed",
                0,
                INITIAL_HARNESS,
                self.splits["train"][: self.config["learning_count"]],
                preflight=True,
            )
            self.event(event="preflight", report=report)
            return
        async with TextCalls(
            self.root / "calls", max_calls=self.config["max_calls"]
        ) as self.calls:
            train = await self.evaluate(
                "baseline/train", INITIAL_HARNESS, self.splits["train"]
            )
            rate = sum(row["passed"] for row in train) / len(train)
            if not 0.25 <= rate <= 0.875:
                raise RuntimeError(
                    "training-only readiness check failed; no held-out results were opened"
                )
            if phase == "readiness":
                return
            trace, harnesses = [], {}
            for seed in self.config["seeds"]:
                self.memory = {arm: () for arm in ARMS}
                self.case_banks = {arm: {} for arm in ARMS}
                current = {arm: INITIAL_HARNESS for arm in ARMS}
                used = {
                    arm: {task["prompt"] for task in self.splits["train"]}
                    for arm in ARMS
                }
                for round_index in range(self.config["rounds"]):
                    feedback = {
                        arm: train
                        if round_index == 0
                        else await self.evaluate(
                            f"seed-{seed}/{arm}/round-{round_index}/diagnostic",
                            current[arm],
                            self.splits["train"],
                        )
                        for arm in ARMS
                    }
                    pools = {
                        arm: await self.generate(
                            seed, arm, round_index, feedback[arm], used[arm]
                        )
                        for arm in ARMS
                    }
                    common = min(map(len, pools.values()))
                    if common < 3:
                        raise RuntimeError(
                            "too few validated practices for an effective comparison"
                        )
                    record = {
                        "seed": seed,
                        "round": round_index,
                        "common_count": common,
                        "arms": {},
                    }
                    order = list(ARMS)
                    random.Random(seed + round_index).shuffle(order)
                    record["execution_order"] = order
                    for arm in order:
                        selected = pools[arm][:common]
                        result = await self.search(
                            seed, arm, round_index, current[arm], selected
                        )
                        current[arm] = result["harness"]
                        used[arm].update(task["prompt"] for task in selected)
                        record["arms"][arm] = {
                            **result,
                            "task_ids": [task["id"] for task in selected],
                        }
                    trace.append(record)
                    freeze(
                        self.root / f"seed-{seed}" / f"round-{round_index}.json", record
                    )
                harnesses[str(seed)] = current
            valid = all(
                sum(
                    row["arms"][arm]["valid_candidate"]
                    for row in trace
                    if row["seed"] == seed
                )
                == self.config["rounds"]
                for seed in self.config["seeds"]
                for arm in ARMS
            )
            freeze(
                self.root / "search-validity.json",
                {
                    "valid": valid,
                    "criterion": "each arm/seed produces a constraint-valid proposal in every round",
                },
            )
            freeze(self.root / "harnesses.json", harnesses)
            if not valid:
                raise RuntimeError(
                    "candidate validity criterion failed; test remains unopened"
                )
            if phase == "optimize":
                return
            baseline = await self.evaluate(
                "final/baseline", INITIAL_HARNESS, self.splits["test"]
            )
            results = {}
            for seed in self.config["seeds"]:
                results[str(seed)] = {}
                for arm in ARMS:
                    harness = harnesses[str(seed)][arm]
                    tests = await self.evaluate(
                        f"final/seed-{seed}/{arm}", harness, self.splits["test"]
                    )
                    repair = await self.evaluate(
                        f"repair/seed-{seed}/{arm}", harness, self.splits["train"]
                    )
                    results[str(seed)][arm] = {"test": tests, "train": repair}
            summary = self.report(baseline, train, results, trace)
            freeze(self.root / "summary.json", summary)
            self.event(event="complete", summary=summary)

    def report(self, baseline, train, results, trace):
        arms = {}
        for arm in ARMS:
            seed_results = []
            for seed, rows in results.items():
                treatment = rows[arm]
                baseline_failures = [
                    i for i, row in enumerate(train) if not row["passed"]
                ]
                baseline_successes = [i for i, row in enumerate(train) if row["passed"]]
                seed_results.append(
                    {
                        "seed": int(seed),
                        "test_passed": sum(row["passed"] for row in treatment["test"]),
                        "vs_baseline": paired_comparison(treatment["test"], baseline),
                        "vs_fixed": paired_comparison(
                            treatment["test"], rows["fixed"]["test"]
                        ),
                        "vs_random": paired_comparison(
                            treatment["test"], rows["random"]["test"]
                        ),
                        "old_failure_repairs": sum(
                            treatment["train"][i]["passed"] for i in baseline_failures
                        ),
                        "old_failures": len(baseline_failures),
                        "old_success_regressions": sum(
                            not treatment["train"][i]["passed"]
                            for i in baseline_successes
                        ),
                        "old_successes": len(baseline_successes),
                    }
                )
            arms[arm] = seed_results
        tokens = Counter()
        missing = 0
        calls = list((self.root / "calls").glob("*/result.json"))
        for path in calls:
            receipt = read_json(path)["receipt"]
            if receipt["usage"] is None:
                missing += 1
            else:
                tokens.update(receipt["usage"]["total"])
        return {
            "kind": "formal-four-arm-multiseed-harness-study",
            "weights_updated": False,
            "models": {key: self.config[key] for key in ("student", "teacher")},
            "baseline_test_passed": sum(row["passed"] for row in baseline),
            "test_count": len(baseline),
            "arms": arms,
            "curve": trace,
            "logical_model_calls": len(calls),
            "native_tokens": dict(tokens),
            "usage_missing_calls": missing,
            "http_request_count": "unknown",
            "interpretation": "Exploratory restricted public IFEval subset; seeds govern optimization sampling, not native decoding. Shared test tasks and baseline are not independent replications.",
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--ifeval-root", required=True)
    parser.add_argument("--previous-splits", required=True)
    parser.add_argument("--student", default="gpt-5.6-luna")
    parser.add_argument("--teacher", default="gpt-6-astra")
    parser.add_argument("--minimum-instructions", type=int, default=2)
    parser.add_argument("--split-seed", type=int, default=20261120)
    parser.add_argument(
        "--phase", choices=("preflight", "readiness", "optimize", "all"), default="all"
    )
    args = parser.parse_args()
    root = Path(args.workspace).resolve()
    os.environ["GEAR_PROFILE_ROOT"] = str(root / "profiles")
    os.environ["GEAR_PYTHON"] = sys.executable
    os.environ["GEAR_COMMAND"] = json.dumps(
        ["node", str(Path(__file__).resolve().parents[2] / "lib/cli.js")]
    )
    config = {
        "student": args.student,
        "teacher": args.teacher,
        "effort": "low",
        "split_seed": args.split_seed,
        "minimum_instructions": args.minimum_instructions,
        "seeds": [101, 202, 303],
        "train_count": 8,
        "learning_count": 6,
        "dev_count": 16,
        "test_count": 24,
        "rounds": 2,
        "max_calls": 1800,
        "structured_output": True,
        "calibration_policy": "constraint-aware-negatives-v1",
    }
    study = Study(
        root,
        Benchmark(args.ifeval_root, minimum_instructions=args.minimum_instructions),
        read_json(args.previous_splits),
        config,
    )
    asyncio.run(study.run(args.phase))


if __name__ == "__main__":
    main()
