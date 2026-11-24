"""A skill-tree teacher using Gear's existing four-stage TrainingLoop.

The default teacher and student are executable CPU arithmetic implementations.
This exercises DataEnvGym's explore / exploit / generate / check / train / feedback
composition; it is not a reproduction of an upstream LLM benchmark or GPU run.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

import failure_curriculum_cpu as domain
from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.curriculum import (
    ExtractOutcomeCases,
    OutcomeRecord,
    PlanPractice,
    PlanSkillPractice,
    ProposeSubskills,
    SelectPractice,
    SkillTree,
    SkillTreeAction,
    Subskill,
    ValidationEvidence,
)
from gear.training import TrainingConfig, TrainingLoop


def operators():
    return {
        **domain.operators(),
        "subskills": ProposeSubskills(),
        "skill_plan": PlanSkillPractice(),
    }


def freeze(path, value):
    value = json.loads(json.dumps(value, allow_nan=False))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and json.loads(path.read_text()) != value:
        raise ValueError("skill-tree caller record changed: " + str(path))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, allow_nan=False))
    temporary.replace(path)


def tree_from_json(value):
    return SkillTree(
        value["skill_id"],
        value["description"],
        tuple(value["families"]),
        tuple(
            Subskill(
                row["skill_id"],
                row["description"],
                tuple(row["families"]),
                row["allocation"],
                tuple(row["source_case_ids"]),
            )
            for row in value["subskills"]
        ),
    )


def interval(identifier):
    side, bucket = identifier.rsplit("-", 1)
    if side not in ("positive", "negative") or bucket not in ("0", "1", "2", "3"):
        raise ValueError("unknown arithmetic subskill")
    sign = 1 if side == "positive" else -1
    return [sign * x for x in range(1 + int(bucket) * 10, 11 + int(bucket) * 10)]


def observe(checkpoint, round_index):
    # Fixed, public training probes. Held-out report points never enter this path.
    records, performance = [], {}
    for side, probes in (("negative", (-4, -1)), ("positive", (1, 4))):
        scores = []
        for x in probes:
            actual, target = domain.predict(checkpoint, x), domain.reference(x)
            scores.append(1 - min(1, abs(actual - target) / (1 + abs(target))))
            records.append(
                OutcomeRecord(
                    digest({"x": x}),
                    "piecewise-linear-train",
                    digest([round_index, digest(checkpoint), x]),
                    0,
                    digest(checkpoint),
                    "arithmetic-cpu-v1",
                    "completed",
                    abs(actual - target) < 1e-9,
                    True,
                    json.dumps({"x": x}),
                    json.dumps({"prediction": actual, "target": target}),
                    (
                        {
                            "round": round_index,
                            "probe": x,
                            "policy_id": digest(checkpoint),
                        },
                    ),
                )
            )
        performance[side] = sum(scores) / len(scores)
    return records, performance


def teacher_action(tree, performance, cases, ops, parameters):
    """One explicit policy in the framework: expand when affordable, else refocus.

    Each root has its own fixed budget. All allocations are per-round generation
    requests; previous successful generations do not silently consume them.
    """
    allocation = parameters["new_subskill_allocation"]
    allocated = sum(child.allocation for child in tree.subskills)
    expand = (
        len(tree.subskills) < parameters["max_subskills_per_root"]
        and (not tree.subskills or performance == 1 or allocated == 0)
        and allocated + allocation <= parameters["per_root_budget"]
    )
    if expand:
        prepared = ops["subskills"].prepare(
            tree, count=1, allocation=allocation, cases=cases
        )
        # Caller-owned domain teacher; an LLM runner would consume the same ModelInput.
        identifier = tree.skill_id + "-" + str(len(tree.subskills))
        supports = [
            case["case_id"]
            for case in prepared.data["cases"]
            if case["outcome"] == "failure"
        ]
        response = {
            "subskills": [
                {
                    "skill_id": identifier,
                    "description": "Evaluate "
                    + tree.skill_id
                    + " inputs with absolute values "
                    + str(1 + 10 * len(tree.subskills))
                    + " through "
                    + str(10 + 10 * len(tree.subskills)),
                    "families": list(tree.families),
                    "source_case_ids": supports,
                }
            ]
        }
        action = ops["subskills"].parse(
            response, tree=tree, count=1, allocation=allocation, cases=cases
        )
        return action, {"request": asdict(prepared), "response": response}
    count = parameters["per_root_budget"] if performance < 1 else 0
    quotient, remainder = divmod(count, len(tree.subskills))
    desired = [quotient + (index < remainder) for index in range(len(tree.subskills))]
    return SkillTreeAction(
        digest(json.loads(json.dumps(asdict(tree)))),
        "exploit",
        allocation_delta=tuple(
            (child.skill_id, count - child.allocation)
            for child, count in zip(tree.subskills, desired, strict=True)
        ),
    ), None


def generate(prepared, *, rng, used):
    target = prepared.data["plan"]["target"]
    choices = [x for x in interval(target["target_id"]) if x not in used]
    choices.sort(key=lambda x: (rng.value("value", x + 40), x))
    return {
        "practices": [
            {
                "instruction": f"Compute the piecewise linear function at x={x}.",
                "family": "piecewise-linear-train",
                "data": {"x": x, "subskill": target["target_id"]},
                "reference": {"answer": x * (3 if x > 0 else 1)},
                "verifier": {"kind": "absolute-error", "tolerance": 1e-9},
            }
            for x in choices[: target["count"]]
        ]
    }


def validate(drafts, ops, ctx, used):
    plan = ops["validate"].plan(drafts)
    evidence = []
    for draft in drafts:
        if draft.draft_id in dict(plan.structural_errors):
            continue
        data = draft.data
        x = data.get("x")
        environment = type(x) is int and 0 < abs(x) <= 40
        expected = domain.reference(x) if environment else None
        reference = draft.reference.get("answer")
        verifier = draft.verifier == {"kind": "absolute-error", "tolerance": 1e-9}

        def accepts(
            value, *, environment=environment, verifier=verifier, expected=expected
        ):
            return (
                environment
                and verifier
                and type(value) in (int, float)
                and abs(value - expected) <= 1e-9
            )

        facts = {
            "environment": environment,
            "reference": accepts(reference),
            "verifier_calibration": accepts(expected)
            and not accepts(0)
            and not accepts(expected + 1),
            "target_fidelity": environment
            and x in interval(draft.plan.target.target_id)
            and data.get("subskill") == draft.plan.target.target_id,
            "novelty": x not in used,
        }
        proof = {
            "draft": asdict(draft),
            "facts": facts,
            "oracle": expected,
            "negative_controls": [0, expected + 1] if environment else [],
            "policy_id": digest(ctx.checkpoint),
            "student_prediction": domain.predict(ctx.checkpoint, x)
            if environment
            else None,
        }
        proof = json.loads(json.dumps(proof))
        path = (
            ctx.workspace
            / "validation"
            / (draft.draft_id.removeprefix("sha256:") + ".json")
        )
        freeze(path, proof)
        for check, passed in facts.items():
            evidence.append(
                ValidationEvidence(
                    draft.draft_id,
                    draft.digest,
                    plan.policy_id,
                    plan.validator_id,
                    check,
                    passed,
                    "structural"
                    if check in ("target_fidelity", "novelty")
                    else "execution",
                    ({"path": str(path), "digest": digest(proof)},),
                )
            )
        if all(facts.values()):
            used.add(x)
    return ops["validate"].assess(plan, evidence)


def audit_records(workspace, parameters):
    records = []
    for path in sorted(Path(workspace).glob("rounds/*/task-source/result.json")):
        stage = json.loads(path.read_text())
        envelope = json.loads((path.parent / "workspace/teacher.json").read_text())
        record = envelope["record"]
        if (
            envelope["digest"] != digest(record)
            or record["operation_id"] != stage["operationId"]
            or record["tasks_digest"] != digest(stage["output"])
            or record["parameters_digest"] != digest(parameters)
        ):
            raise ValueError(
                "skill-tree evidence differs from its completed training stage"
            )
        for result in record["validation"]["results"]:
            for check in result["checks"]:
                for ref in check["evidence_refs"]:
                    if (
                        digest(json.loads(Path(ref["path"]).read_text()))
                        != ref["digest"]
                    ):
                        raise ValueError("skill-tree validation evidence changed")
        records.append(record)
    return records


class TaskSource:
    source_dependencies = (domain.__file__, *domain.TaskSource.source_dependencies)

    def generate(self, ctx):
        ops = operators()
        prior = audit_records(ctx.run_workspace, ctx.config.parameters)
        if len(prior) != ctx.round_index:
            raise ValueError(
                "skill-tree history does not match the current training step"
            )
        records, performance = observe(ctx.checkpoint, ctx.round_index)
        current = ExtractOutcomeCases()(records)
        bank = list(records)
        for row in prior:
            bank.extend(
                OutcomeRecord(
                    **{**value, "evidence_refs": tuple(value["evidence_refs"])}
                )
                for value in row["observations"]
            )
        cases = ExtractOutcomeCases()(bank)
        trees, actions, proposals, drafts = {}, {}, {}, []
        used = {task["x"] for row in ctx.history for task in row["tasks"]}
        for side in ("negative", "positive"):
            tree = (
                tree_from_json(prior[-1]["trees"][side])
                if prior
                else SkillTree(
                    side,
                    "Piecewise function on " + side + " inputs",
                    ("piecewise-linear-train",),
                )
            )
            observations = tuple(
                case
                for case in current
                if (json.loads(case.record.instruction)["x"] > 0)
                == (side == "positive")
            )
            action, proposal = teacher_action(
                tree, performance[side], observations, ops, ctx.config.parameters
            )
            planned = ops["skill_plan"](
                tree, action, budget=ctx.config.parameters["per_root_budget"]
            )
            trees[side], actions[side], proposals[side] = (
                asdict(planned.tree),
                asdict(action),
                proposal,
            )
            for target in planned.targets:
                plan = PlanPractice(
                    ops["generate"].identity,
                    ops["validate"].identity,
                    "failure" if target.source_case_ids else "random",
                )((target,))[0]
                prepared = ops["generate"].prepare(plan, cases=cases)
                response = generate(
                    prepared,
                    rng=DeterministicRandom(
                        f"{ctx.config.parameters['seed']}/{ctx.round_index}/{target.target_id}"
                    ),
                    used=used,
                )
                generated = ops["generate"].parse(response, plan=plan)
                drafts.extend(generated)
        report = validate(drafts, ops, ctx, set(used))
        selection = SelectPractice()(
            drafts,
            report,
            budget=2 * ctx.config.parameters["per_root_budget"],
            base_pool_version=digest(sorted(used)),
        )
        selected = {item.draft_id for item in selection.selections}
        tasks = [
            {"x": draft.data["x"], "target": draft.reference["answer"]}
            for draft in drafts
            if draft.draft_id in selected
        ]
        record = {
            "operation_id": ctx.operation_id,
            "parameters_digest": digest(ctx.config.parameters),
            "tasks_digest": digest(tasks),
            "policy_id": digest(ctx.checkpoint),
            "trees": trees,
            "actions": actions,
            "subskill_proposals": proposals,
            "observations": [asdict(row) for row in records],
            "performance": performance,
            "observed_gain": {
                side: performance[side] - prior[-1]["performance"][side]
                if prior
                else None
                for side in performance
            },
            "requested": sum(
                child["allocation"]
                for tree in trees.values()
                for child in tree["subskills"]
            ),
            "generated": len(drafts),
            "admitted": len(tasks),
            "validation": asdict(report),
            "selection": asdict(selection),
        }
        record = json.loads(json.dumps(record))
        freeze(
            ctx.workspace / "teacher.json", {"record": record, "digest": digest(record)}
        )
        return tasks


class ModelUpdater(domain.ModelUpdater):
    source_dependencies = (domain.__file__,)

    def update(self, ctx, dataset):
        # Zero allocations or rejected proposals are an explicit no-update round.
        if not dataset["samples"]:
            return dict(ctx.checkpoint)
        return super().update(ctx, dataset)


def run_example(workspace, *, rounds=6, seed="0", per_root_budget=4):
    if type(per_root_budget) is not int or per_root_budget < 2:
        raise ValueError(
            "per_root_budget must allow the two-example exploration action"
        )
    parameters = {
        "seed": seed,
        "learning_rate": 0.5,
        "per_root_budget": per_root_budget,
        "new_subskill_allocation": 2,
        "max_subskills_per_root": 4,
        "empty_pool": "skip-update",
        "teacher_policy": "expand-or-refocus-v1",
        "operators": {
            key: value.describe().to_dict() for key, value in operators().items()
        },
    }
    initial = {"negative": 1.0, "positive": 0.0}
    audit_records(workspace, parameters)
    result = TrainingLoop(
        TaskSource(), domain.RolloutExecutor(), domain.DatasetBuilder(), ModelUpdater()
    ).run(
        TrainingConfig(
            workspace, rounds, initial_checkpoint=initial, parameters=parameters
        )
    )
    records = audit_records(workspace, parameters)

    def loss(checkpoint):
        return (
            sum(
                (domain.predict(checkpoint, x) - domain.reference(x)) ** 2
                for x in (-100, -75, 75, 100)
            )
            / 4
        )

    return {
        "rounds_completed": result.rounds_completed,
        "checkpoint": result.checkpoint,
        "initial_held_out_mse": loss(initial),
        "final_held_out_mse": loss(result.checkpoint),
        "held_out_curve": [loss(row["checkpoint"]) for row in result.history],
        "actions": [
            {side: row["actions"][side]["kind"] for side in row["actions"]}
            for row in records
        ],
        "counts": [
            {name: row[name] for name in ("requested", "generated", "admitted")}
            for row in records
        ],
        "observed_gain": [row["observed_gain"] for row in records],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument("--seed", default="0")
    parser.add_argument("--per-root-budget", type=int, default=4)
    args = parser.parse_args()
    print(
        json.dumps(
            run_example(
                args.workspace,
                rounds=args.rounds,
                seed=args.seed,
                per_root_budget=args.per_root_budget,
            ),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
