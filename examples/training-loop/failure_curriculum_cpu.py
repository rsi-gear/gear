"""An executable CPU failure -> new tasks -> update -> reevaluate example.

The teacher is deterministic arithmetic code, not an LLM. It exercises the same
prepare/parse boundary a caller can connect to its own model runner. No generated
code is executed. The original executor task format remains {x, target}.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

import gear.curriculum
from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.curriculum import (
    ContrastiveDiagnoser,
    ExtractOutcomeCases,
    GeneratePractice,
    LearningTarget,
    MergeFailureMemory,
    OutcomeRecord,
    PlanPractice,
    SelectLearningTargets,
    SelectPractice,
    ValidatePractice,
    ValidationEvidence,
)
from gear.training import TrainingConfig, TrainingLoop


def reference(x):
    # Independent task oracle, used only by caller-owned validation/evaluation.
    return sum([x, x, x]) if x > 0 else x


def predict(checkpoint, x):
    return checkpoint["positive" if x > 0 else "negative"] * x


def seed_tasks():
    return [{"x": x, "target": reference(x)} for x in (-2, -1, 1, 2)]


def operators():
    return {
        "extract": ExtractOutcomeCases(),
        "diagnose": ContrastiveDiagnoser(),
        "merge": MergeFailureMemory(),
        "targets": SelectLearningTargets(),
        "generate": GeneratePractice(),
        "validate": ValidatePractice("piecewise-arithmetic-checks-v1"),
        "select": SelectPractice(),
    }


def offline_diagnose(model_input):
    """Caller-owned domain teacher: classify actual observed errors by sign."""
    modes = []
    for side in ("positive", "negative"):
        cases = [
            case
            for case in model_input.data["cases"]
            if (json.loads(case["record"]["instruction"])["x"] > 0) == (side == "positive")
        ]
        support = [case["case_id"] for case in cases if case["outcome"] == "failure"]
        if support:
            modes.append(
                {
                    "mode_id": side + "-slope",
                    "description": side + " slope is inaccurate",
                    "support_case_ids": support,
                    "counterexample_case_ids": [],
                }
            )
    return {"modes": modes}


def offline_generate(model_input, *, rng, used):
    """Procedurally generate unseen inputs; random mode never receives failures."""
    plan = model_input.data["plan"]
    pool = [x for x in range(-40, 41) if x and x not in used]
    if plan["conditioning"] == "failure":
        positive = plan["target"]["target_id"] == "positive-slope"
        pool = [x for x in pool if (x > 0) == positive]
    pool.sort(key=lambda x: (rng.value("new-input", x + 40), x))
    return {
        "practices": [
            {
                "instruction": f"Compute the piecewise linear function at x={x}.",
                "family": "piecewise-linear-train",
                "data": {"x": x},
                "reference": {"answer": (3 if x > 0 else 1) * x},
                "verifier": {"kind": "absolute-error", "tolerance": 1e-9},
            }
            for x in pool[: plan["target"]["count"]]
        ]
    }


def run_checks(plan, workspace, used):
    """Seal task bytes, run bounded arithmetic checks, save the actual evidence."""
    evidence = []
    invalid = dict(plan.structural_errors)
    for draft in plan.drafts:
        if draft.draft_id in invalid:
            continue
        directory = workspace / "drafts" / draft.draft_id.removeprefix("sha256:")
        directory.mkdir(parents=True, exist_ok=True)
        sealed = asdict(draft)
        (directory / "task.json").write_text(json.dumps(sealed, sort_keys=True))
        material = json.loads((directory / "task.json").read_text())
        if digest(material) != draft.digest:
            raise ValueError("sealed draft changed")
        x = material["data"].get("x")
        environment = type(x) is int and 0 < abs(x) <= 40
        answer = material["reference"].get("answer")
        verifier = material["verifier"]
        valid_verifier = (
            verifier.get("kind") == "absolute-error"
            and type(verifier.get("tolerance")) in (int, float)
            and 0 <= verifier["tolerance"] < 0.1
        )
        expected = reference(x) if environment else None

        def accepts(
            value,
            environment=environment,
            valid_verifier=valid_verifier,
            expected=expected,
            verifier=verifier,
        ):
            return (
                environment
                and valid_verifier
                and type(value) in (int, float)
                and abs(value - expected) <= verifier["tolerance"]
            )

        calibration = (
            environment
            and accepts(expected)
            and all(not accepts(wrong) for wrong in (expected + 1, expected - 1, 0))
        )
        target = draft.plan.target.target_id
        fidelity = environment and (
            draft.plan.conditioning == "random" or (x > 0) == (target == "positive-slope")
        )
        facts = {
            "environment": (environment, "execution", {"x": x}),
            "reference": (
                accepts(answer),
                "execution",
                {"answer": answer, "oracle": expected},
            ),
            "verifier_calibration": (
                calibration,
                "execution",
                {
                    "correct": expected,
                    "wrong": [expected + 1, expected - 1, 0] if environment else [],
                },
            ),
            "target_fidelity": (fidelity, "structural", {"target": target, "x": x}),
            # In this finite domain, semantic equivalence is exactly equality of x.
            "novelty": (
                x not in used,
                "structural",
                {"seen_inputs": sorted(used), "x": x},
            ),
        }
        for name, (passed, kind, details) in facts.items():
            record = {
                "draft_digest": draft.digest,
                "check": name,
                "passed": passed,
                "policy_id": plan.policy_id,
                "validator_id": plan.validator_id,
                "details": details,
            }
            path = directory / (name + ".json")
            path.write_text(json.dumps(record, sort_keys=True))
            evidence.append(
                ValidationEvidence(
                    draft.draft_id,
                    draft.digest,
                    plan.policy_id,
                    plan.validator_id,
                    name,
                    passed,
                    kind,
                    ({"path": str(path), "digest": digest(record)},),
                )
            )
    return tuple(evidence)


class TaskSource:
    # Training stage_identity captures explicit sources; Module parameters are
    # additionally recorded in TrainingConfig.parameters by run_example.
    source_dependencies = tuple(
        sorted(
            str(path)
            for path in (
                *Path(gear.curriculum.__file__).parent.glob("*.py"),
                *(Path(gear.curriculum.__file__).parents[1] / "core").glob("*.py"),
                Path(gear.curriculum.__file__).parents[1] / "canonical.py",
            )
        )
    )

    def generate(self, ctx):
        ops = operators()
        records = []
        for round_ in ctx.history:
            for index, row in enumerate(round_["trajectories"]):
                records.append(
                    OutcomeRecord(
                        task_id=digest({"x": row["x"]}),
                        family="piecewise-linear-train",
                        sample_id=digest([str(ctx.run_workspace), round_["round_index"], index]),
                        attempt=0,
                        policy_id=row["policy_id"],
                        environment_id="arithmetic-cpu-v1",
                        status="completed",
                        passed=abs(row["prediction"] - row["target"]) < 1e-9,
                        complete=True,
                        instruction=json.dumps({"x": row["x"]}),
                        feedback=f"prediction={row['prediction']}, target={row['target']}",
                        evidence_refs=({"round": round_["round_index"], "sample": index},),
                    )
                )
        cases = ops["extract"](records)
        # Reconstruct memory from completed history: no hidden instance state or
        # external charged calls. Local arithmetic is safe to repeat after a crash.
        diagnosis = ops["diagnose"].parse(
            offline_diagnose(ops["diagnose"].prepare(cases)), cases=cases
        )
        memory = ops["merge"]((), diagnosis)
        tasks = seed_tasks()
        details = {
            "memory": asdict_memory(memory),
            "drafts": [],
            "report": None,
            "pool": None,
        }
        strategy = ctx.config.parameters["strategy"]
        if ctx.round_index and strategy != "fixed":
            targets = ops["targets"](memory, budget=4)
            if strategy == "random":
                targets = (
                    LearningTarget(
                        "random-domain",
                        "Sample the piecewise linear training domain",
                        4,
                        (),
                        ("piecewise-linear-train",),
                    ),
                )
            if targets:
                planner = PlanPractice(
                    ops["generate"].identity,
                    ops["validate"].identity,
                    conditioning="random" if strategy == "random" else "failure",
                )
                drafts = []
                used = {row["x"] for round_ in ctx.history for row in round_["tasks"]}
                for plan in planner(targets):
                    model_input = ops["generate"].prepare(plan, cases=cases)
                    response = offline_generate(
                        model_input,
                        rng=DeterministicRandom(
                            f"{ctx.config.parameters['seed']}:{ctx.round_index}:{plan.target.target_id}"
                        ),
                        used=used,
                    )
                    drafts.extend(ops["generate"].parse(response, plan=plan))
                checks = ops["validate"].plan(drafts)
                report = ops["validate"].assess(checks, run_checks(checks, ctx.workspace, used))
                pool = ops["select"](
                    drafts, report, budget=4, base_pool_version=digest(ctx.history)
                )
                selected = {item.draft_id for item in pool.selections}
                # Conversion lives here and preserves the executor's original format.
                tasks = [
                    {"x": draft.data["x"], "target": draft.reference["answer"]}
                    for draft in drafts
                    if draft.draft_id in selected
                ]
                if not tasks:  # Explicit, frozen fallback policy in run_example.
                    tasks = seed_tasks()
                details.update(
                    drafts=[asdict(item) for item in drafts],
                    report=asdict(report),
                    pool=asdict(pool),
                )
        record = {
            "operation_id": ctx.operation_id,
            "parameters_digest": digest(ctx.config.parameters),
            "tasks_digest": digest(tasks),
            **details,
        }
        record = json.loads(json.dumps(record))
        temporary = ctx.workspace / "curriculum.tmp"
        temporary.write_text(
            json.dumps({"record": record, "digest": digest(record)}, sort_keys=True)
        )
        temporary.replace(ctx.workspace / "curriculum.json")
        return tasks


def asdict_memory(memory):
    return [asdict(mode) for mode in memory]


class RolloutExecutor:
    def execute(self, ctx, tasks):
        return [
            {
                **task,
                "prediction": predict(ctx.checkpoint, task["x"]),
                "policy_id": digest(ctx.checkpoint),
            }
            for task in tasks
        ]


class DatasetBuilder:
    def build(self, ctx, trajectories):
        # Synthetic scalar regression examples; these are not native LLM receipts.
        return {"samples": trajectories, "kind": "synthetic-scalar-regression"}


class ModelUpdater:
    def update(self, ctx, dataset):
        checkpoint = dict(ctx.checkpoint)
        rows = dataset["samples"]
        for side in ("negative", "positive"):
            gradient = sum(
                2 * (row["prediction"] - row["target"]) / row["x"]
                for row in rows
                if (row["x"] > 0) == (side == "positive")
            ) / len(rows)
            checkpoint[side] -= ctx.config.parameters["learning_rate"] * gradient
        return checkpoint


def audit_records(workspace, parameters):
    # Completed TrainingLoop stages do not re-enter TaskSource.generate on resume.
    # The caller therefore checks its additional records explicitly.
    for completed in sorted(Path(workspace).glob("rounds/*/task-source/result.json")):
        stage = completed.parent
        envelope = json.loads((stage / "workspace" / "curriculum.json").read_text())
        record = envelope["record"]
        stage_record = json.loads(completed.read_text())
        if (
            envelope["digest"] != digest(record)
            or record["tasks_digest"] != digest(stage_record["output"])
            or record["parameters_digest"] != digest(parameters)
            or record["operation_id"] != stage_record["operationId"]
        ):
            raise ValueError("curriculum record does not match the completed stage")
        for draft in record["drafts"]:
            directory = stage / "workspace" / "drafts" / draft["draft_id"].removeprefix("sha256:")
            if digest(json.loads((directory / "task.json").read_text())) != digest(draft):
                raise ValueError("sealed task record changed")
        if record["report"]:
            for item in record["report"]["results"]:
                for check in item["checks"]:
                    for ref in check["evidence_refs"]:
                        if digest(json.loads(Path(ref["path"]).read_text())) != ref["digest"]:
                            raise ValueError("validation evidence changed")


def run_example(workspace, *, strategy="failure", rounds=4, seed="0"):
    if strategy not in ("fixed", "random", "failure"):
        raise ValueError("unknown strategy")
    parameters = {
        "strategy": strategy,
        "seed": seed,
        "budget": 4,
        "fallback": "seed-tasks",
        "learning_rate": 0.5,
        "operators": {
            name: operator.describe().to_dict() for name, operator in operators().items()
        },
    }
    initial = {"negative": 1.0, "positive": 0.0}
    audit_records(workspace, parameters)
    result = TrainingLoop(TaskSource(), RolloutExecutor(), DatasetBuilder(), ModelUpdater()).run(
        TrainingConfig(workspace, rounds, initial_checkpoint=initial, parameters=parameters)
    )
    audit_records(workspace, parameters)
    # Evaluation inputs are local to reporting, never provided to TaskSource/teacher.
    held_out = (-100, -75, 75, 100)

    def loss(checkpoint):
        return sum((predict(checkpoint, x) - reference(x)) ** 2 for x in held_out) / len(held_out)

    return {
        "strategy": strategy,
        "rounds_completed": result.rounds_completed,
        "checkpoint": result.checkpoint,
        "initial_held_out_mse": loss(initial),
        "final_held_out_mse": loss(result.checkpoint),
        "held_out_curve": [loss(row["checkpoint"]) for row in result.history],
        "tasks_per_round": [len(row["tasks"]) for row in result.history],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--strategy", choices=("fixed", "random", "failure"), default="failure")
    parser.add_argument("--rounds", type=int, default=4)
    parser.add_argument("--seed", default="0")
    args = parser.parse_args()
    print(
        json.dumps(
            run_example(
                args.workspace,
                strategy=args.strategy,
                rounds=args.rounds,
                seed=args.seed,
            ),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
