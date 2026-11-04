"""Research workflow examples using independent trials and recorded evidence.

These focus on the public contracts needed by ACE, DarwinX and RRSI. They do
not reproduce every upstream parameter, prompt or search heuristic.
"""

from dataclasses import asdict
from statistics import mean
from typing import ClassVar, cast

from gear.algorithms import Role, RunContext, WorkflowAlgorithm, WorkflowResult
from gear.canonical import JSON


def score(measured):
    if not measured.ok:
        raise ValueError("complete scored research trials are required")
    return mean(row.evidence.score for row in measured.observations)


class ACEExample(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "reflector": Role(
            "Explain the completed attempt in operation.payload.inputs.",
            {"type": "string"},
        ),
        "curator": Role(
            "Update the playbook from this reflection and its evidence.",
            {"type": "string"},
            edits=True,
        ),
    }

    def __init__(self, max_steps: int = 2):
        self.configuration = {"max_steps": max_steps}
        self.max_steps = max_steps

    async def run(self, ctx: RunContext) -> WorkflowResult:
        current, initial_scores = ctx.inputs.anchor, []
        for step, task in enumerate(ctx.data.train[: self.max_steps]):
            first = await ctx.measure(current, tasks=[task], key=f"{step}/first")
            initial_scores.append(score(first))
            reflection = await ctx.roles.call(
                "reflector",
                inputs=cast(JSON, [asdict(row.evidence) for row in first.observations]),
                key=f"{step}/reflect",
            )
            retry = await ctx.measure(
                current,
                tasks=[
                    ctx.data.derive(
                        task,
                        str(reflection.data) + "\n" + ctx.data.question(task),
                        id="retry",
                    )
                ],
                key=f"{step}/retry",
            )
            score(retry)
            edit = await ctx.roles.call(
                "curator",
                candidate=current,
                inputs=reflection.data,
                key=f"{step}/curate",
            )
            if edit.ok:
                current = edit.candidate
        return ctx.result(
            selected=current,
            nominate=False,
            data={
                "online_score": mean(initial_scores),
                "first_observations": len(initial_scores),
            },
        )


class DarwinXExample(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "mutator": Role(
            "Create a distinct general improvement described in operation.payload.inputs.",
            {"type": "string"},
            edits=True,
        ),
        "recombiner": Role(
            "Inspect the writable primary and the donor/ancestor reference directories. Combine complementary behavior.",
            {"type": "string"},
            edits=True,
        ),
    }

    async def run(self, ctx: RunContext) -> WorkflowResult:
        ancestor = ctx.inputs.anchor
        a = await ctx.roles.call(
            "mutator", candidate=ancestor, inputs="first direction", key="parent/a"
        )
        b = await ctx.roles.call(
            "mutator", candidate=ancestor, inputs="second direction", key="parent/b"
        )
        if not a.ok or not b.ok:
            return ctx.result(reason="parent generation failed")
        merged = await ctx.roles.call(
            "recombiner",
            candidate=a.candidate,
            references={"donor": b.candidate, "ancestor": ancestor},
            key="merge",
        )
        if not merged.ok:
            return ctx.result(selected=a.candidate, nominate=False)
        phases = {}
        selected = a.candidate
        for phase in ("screen", "confirmation"):
            values, profiles = [], []
            for name, candidate in (
                ("primary", a.candidate),
                ("donor", b.candidate),
                ("merged", merged.candidate),
            ):
                measured = await ctx.measure(
                    candidate,
                    tasks=ctx.data.train,
                    repetitions=2 if phase == "confirmation" else 1,
                    key=f"{phase}/{name}",
                )
                values.append(score(measured))
                profiles.append(
                    {
                        task.id: mean(
                            row.evidence.score
                            for row in measured.observations
                            if row.task_id == task.id
                        )
                        for task in ctx.data.train
                    }
                )
            phases[phase] = values
            preserves = all(
                profiles[2][task] >= max(profiles[0][task], profiles[1][task])
                for task in profiles[2]
            )
            if not preserves or values[2] <= max(values[:2]):
                selected = a.candidate
                break
            selected = merged.candidate
        return ctx.result(
            selected=selected, nominate=False, data=cast(JSON, {"comparisons": phases})
        )


class RRSIMechanismExample(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "editor": Role(
            "Improve the current draft using the critic feedback in operation.payload.inputs.",
            {"type": "string"},
            edits=True,
        ),
        "digester": Role(
            "Return one exact quoted substring from the trace in operation.payload.inputs.",
            {
                "type": "object",
                "properties": {"quote": {"type": "string"}},
                "required": ["quote"],
                "additionalProperties": False,
            },
        ),
        "critic": Role(
            "Review the complete changes in operation.payload.inputs.",
            {
                "type": "object",
                "properties": {"accept": {"type": "boolean"}},
                "required": ["accept"],
                "additionalProperties": False,
            },
        ),
    }

    async def run(self, ctx: RunContext) -> WorkflowResult:
        parent = ctx.inputs.anchor
        calibration = []
        for index in range(2):
            measured = await ctx.measure(
                parent, tasks=ctx.data.train, repetitions=2, key=f"calibration/{index}"
            )
            calibration.append(score(measured))
        trace = await ctx.evidence.trajectory(measured.observations[0], key="trace")
        digest_result = await ctx.roles.call(
            "digester", inputs=trace.data, key="digest"
        )

        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)

        quote = digest_result.data["quote"]
        if not quote or not any(quote in value for value in strings(trace.data)):
            return ctx.result(
                selected=parent,
                nominate=False,
                data={
                    "measurement": "invalid",
                    "reason": "trace quote does not match source",
                },
            )
        draft = await ctx.workspaces.open(base=parent, key="draft")
        feedback = None
        for attempt in range(2):
            edit = await ctx.roles.call(
                "editor", workspace=draft, inputs=feedback, key=f"edit/{attempt}"
            )
            if not edit.ok:
                await ctx.workspaces.discard(draft, key="discard")
                return ctx.result(reason="editor declined")
            draft = edit.revision
            changes = await ctx.artifacts.diff(parent, draft, key=f"diff/{attempt}")
            verdict = await ctx.roles.call(
                "critic", inputs=changes, key=f"critic/{attempt}"
            )
            if verdict.ok and verdict.data["accept"]:
                break
            feedback = verdict.data
        else:
            await ctx.workspaces.discard(draft, key="discard")
            return ctx.result(reason="critic rejected")
        candidate = await ctx.workspaces.seal(draft, key="seal")
        results = []
        for name, version in (("parent", parent), ("candidate", candidate)):
            measured = await ctx.measure(
                version, tasks=ctx.data.train, repetitions=2, key=f"measure/{name}"
            )
            value = score(measured)
            guards = [
                row.evidence.raw_metrics.get("quality")
                if row.evidence.raw_metrics
                else None
                for row in measured.observations
            ]
            if any(
                not isinstance(guard, dict)
                or guard.get("status") != "available"
                or guard.get("value", 0) < 0.5
                for guard in guards
            ):
                return ctx.result(
                    selected=parent,
                    nominate=False,
                    data={
                        "measurement": "invalid",
                        "reason": "quality guard unavailable or below floor",
                    },
                )
            costs = [
                row.usage.get("total_tokens")
                if isinstance(row.usage, dict) and row.usage.get("complete") is True
                else None
                for row in measured.observations
            ]
            if any(type(cost) not in (int, float) or cost <= 0 for cost in costs):
                return ctx.result(
                    selected=parent,
                    nominate=False,
                    data={
                        "measurement": "invalid",
                        "reason": "complete target-token usage required",
                    },
                )
            results.append((value, mean(costs)))
        accepted = results[1][0] >= results[0][0] and results[1][1] < results[0][1]
        return ctx.result(
            selected=candidate if accepted else parent,
            nominate=False,
            data=cast(
                JSON,
                {
                    "score_cost": results,
                    "accepted": accepted,
                    "calibration": calibration,
                    "trace_quote": quote,
                },
            ),
        )
