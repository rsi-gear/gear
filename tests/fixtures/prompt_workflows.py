"""Prompt search workflows exercised with deterministic model and evaluation replies."""

from typing import ClassVar

from gear.algorithms import Role, WorkflowAlgorithm


def score(result):
    assert result.ok
    return sum(row.evidence.score for row in result.observations) / len(
        result.observations
    )


class TextSearch(WorkflowAlgorithm):
    async def text(self, ctx, candidate, key):
        layout = await ctx.artifacts.list(candidate, key=key + "/layout")
        path = layout["harness"]["instructionFile"]
        return (await ctx.artifacts.read(candidate, paths=[path], key=key))[path]

    async def prompt(self, ctx, base, text, key):
        layout = await ctx.artifacts.list(base, key=key + "/layout")
        return await ctx.artifacts.apply(
            base=base, edits={layout["harness"]["instructionFile"]: text}, key=key
        )


class EvoPrompt(TextSearch):
    roles: ClassVar[dict[str, Role]] = {
        "crossover": Role("Combine the supplied prompts.", {"type": "string"})
    }

    def __init__(self, variation="ga"):
        self.variation = variation
        self.configuration = {"variation": variation}

    async def run(self, ctx):
        population = [ctx.inputs.anchor]
        for index in range(3):
            population.append(
                await self.prompt(
                    ctx, ctx.inputs.anchor, f"parent-{index}", f"parent/{index}"
                )
            )
        texts = [
            await self.text(ctx, parent, f"read/{index}")
            for index, parent in enumerate(population)
        ]
        sources = texts[:2] if self.variation == "ga" else texts
        assert len(sources) == (2 if self.variation == "ga" else 4)
        for attempt in range(2):
            reply = await ctx.roles.call(
                "crossover",
                inputs={"variation": self.variation, "prompts": sources},
                key=f"cross/{attempt}",
            )
            if reply.data in texts:
                continue
            child = await self.prompt(ctx, population[0], reply.data, "child")
            measured = await ctx.measure(child, tasks=ctx.data.dev, key="child/dev")
            assert score(measured) > 0.5
            return ctx.result(
                selected=child,
                nominate=False,
                data={"sources": len(sources), "duplicates": attempt},
            )
        raise AssertionError("fixture should produce a novel prompt")


class OPRO(TextSearch):
    roles: ClassVar[dict[str, Role]] = {
        "optimizer": Role(
            "Propose a new prompt using scored history and examples.",
            {"type": "string"},
        )
    }

    async def run(self, ctx):
        anchor = ctx.inputs.anchor
        text = await self.text(ctx, anchor, "read")
        baseline = await ctx.measure(anchor, tasks=ctx.data.train, key="baseline")
        history = [{"text": text, "score": score(baseline)}]
        examples = [
            {
                "question": ctx.data.question(row.task_id),
                "output": row.output,
                "score": row.evidence.score,
            }
            for row in baseline.observations
        ]
        assert all(row["output"] for row in examples)
        for attempt in range(2):
            reply = await ctx.roles.call(
                "optimizer",
                inputs={"history": history, "examples": examples},
                key=f"propose/{attempt}",
            )
            if reply.data in {row["text"] for row in history}:
                continue
            child = await self.prompt(ctx, anchor, reply.data, "child")
            measured = await ctx.measure(child, tasks=ctx.data.train, key="candidate")
            history.append({"text": reply.data, "score": score(measured)})
            assert history[-1]["score"] > history[0]["score"]
            return ctx.result(
                selected=child,
                nominate=False,
                data={"duplicates": attempt, "history": history},
            )
        raise AssertionError("fixture should produce a novel prompt")


class Arbor(TextSearch):
    roles: ClassVar[dict[str, Role]] = {
        "coordinator": Role("Choose a conceptual tree action.", {"type": "object"}),
        "implement": Role(
            "Implement the chosen experiment on the supplied trunk.", {"type": "string"}
        ),
        "summarize": Role(
            "Summarize this experiment for its conceptual ancestor.", {"type": "string"}
        ),
    }

    async def run(self, ctx):
        trunk = ctx.inputs.anchor
        train_score = score(
            await ctx.measure(trunk, tasks=ctx.data.train, key="baseline/train")
        )
        dev_score = score(
            await ctx.measure(trunk, tasks=ctx.data.dev, key="baseline/dev")
        )
        tree = {"idea": {"status": "direction"}, "pruned": {"status": "pending"}}
        dev_calls = 0
        for index in range(4):
            action = (
                await ctx.roles.call(
                    "coordinator",
                    inputs={"tree": tree, "trunk": trunk.id},
                    key=f"plan/{index}",
                )
            ).data
            if action["action"] == "prune":
                tree[action["node"]]["status"] = "pruned"
                continue
            node = action["node"]
            text = (
                await ctx.roles.call(
                    "implement",
                    candidate=trunk,
                    inputs={
                        "node": node,
                        "conceptual_parent": "idea",
                        "trunk": trunk.id,
                    },
                    key=f"edit/{index}",
                )
            ).data
            candidate = await self.prompt(ctx, trunk, text, f"candidate/{index}")
            measured = await ctx.measure(
                candidate, tasks=ctx.data.train, key=f"train/{index}"
            )
            value = score(measured)
            status = "train_regressed"
            if value >= train_score:
                dev_calls += 1
                selected = score(
                    await ctx.measure(candidate, tasks=ctx.data.dev, key=f"dev/{index}")
                )
                status = "dev_tied"
                if selected > dev_score:
                    trunk, train_score, dev_score, status = (
                        candidate,
                        value,
                        selected,
                        "merged",
                    )
            tree[node] = {"status": status}
            lesson = await ctx.roles.call(
                "summarize",
                inputs={"node": node, "parent": "idea", "result": status},
                key=f"backprop/{index}",
            )
            tree["idea"]["insight"] = lesson.data
        assert (
            tree["pruned"]["status"] == "pruned"
            and tree["regress"]["status"] == "train_regressed"
        )
        assert (
            tree["tie"]["status"] == "dev_tied" and tree["winner"]["status"] == "merged"
        )
        return ctx.result(
            selected=trunk, nominate=False, data={"tree": tree, "dev_calls": dev_calls}
        )


class TrainDevGEPA(TextSearch):
    roles: ClassVar[dict[str, Role]] = {
        "reflector": Role(
            "Reflect on the labeled minibatch and rewrite its prompt.",
            {"type": "string"},
        )
    }

    async def run(self, ctx):
        parent = ctx.inputs.anchor
        before = await ctx.measure(
            parent, tasks=ctx.data.train[:1], key="minibatch/parent"
        )
        baseline_dev = score(
            await ctx.measure(parent, tasks=ctx.data.dev, key="baseline/dev")
        )
        row = before.observations[0]
        reply = await ctx.roles.call(
            "reflector",
            inputs={
                "instruction": await self.text(ctx, parent, "read"),
                "question": ctx.data.question(row.task_id),
                "expected": ctx.data.expected(row.task_id),
                "output": row.output,
                "parent_score": row.evidence.score,
            },
            key="reflect",
        )
        candidate = await self.prompt(ctx, parent, reply.data, "candidate")
        after = await ctx.measure(
            candidate, tasks=ctx.data.train[:1], key="minibatch/child"
        )
        assert score(after) >= score(before)
        measured = await ctx.measure(candidate, tasks=ctx.data.dev, key="candidate/dev")
        selected = candidate if score(measured) > baseline_dev else parent
        return ctx.result(
            selected=selected, nominate=False, data={"baseline_trial": row.id}
        )


class SkillOpt(TextSearch):
    roles: ClassVar[dict[str, Role]] = {
        "reflect_failure": Role(
            "Propose a skill patch from failed trials.", {"type": "object"}
        ),
        "reflect_success": Role(
            "Propose a skill patch from successful trials.", {"type": "object"}
        ),
        "consolidate": Role(
            "Merge skill patches, preserving KEEP.", {"type": "object"}
        ),
    }

    async def run(self, ctx):
        current = ctx.inputs.anchor
        best = score(await ctx.measure(current, tasks=ctx.data.dev, key="baseline/dev"))
        training = await ctx.measure(current, tasks=ctx.data.train, key="training")
        groups = {"success": [], "failure": []}
        for row in training.observations:
            groups["success" if row.evidence.score > 0.5 else "failure"].append(
                row.task_id
            )
        proposals = []
        for source, tasks in groups.items():
            proposals.append(
                (
                    await ctx.roles.call(
                        "reflect_" + source,
                        inputs={"tasks": tasks},
                        key="reflect/" + source,
                    )
                ).data
            )
        rejected, tied = 0, 0
        for attempt in range(3):
            patch = (
                await ctx.roles.call(
                    "consolidate", inputs=proposals, key=f"merge/{attempt}"
                )
            ).data
            if "KEEP" not in patch["AGENTS.md"]:
                rejected += 1
                continue
            candidate = await ctx.artifacts.apply(
                base=current, edits=patch, key=f"apply/{attempt}"
            )
            measured = score(
                await ctx.measure(candidate, tasks=ctx.data.dev, key=f"dev/{attempt}")
            )
            if measured > best:
                previous, current, best = current, candidate, measured
            else:
                tied += 1
        before = await ctx.measure(previous, tasks=ctx.data.train, key="slow/before")
        after = await ctx.measure(current, tasks=ctx.data.train, key="slow/after")
        assert [row.task_id for row in before.observations] == [
            row.task_id for row in after.observations
        ]
        diff = await ctx.artifacts.diff(previous, current, key="diff")
        assert len(diff["files"]) == 2 and rejected == tied == 1
        return ctx.result(
            selected=current, nominate=False, data={"rejected": rejected, "tied": tied}
        )
