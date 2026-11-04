"""Review and repair a draft before counting it as a candidate."""

from typing import ClassVar

from gear.algorithms import Role, WorkflowAlgorithm


class ReviewedEdit(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "editor": Role(
            "Improve the allowed candidate files using the supplied feedback.",
            {"type": "string"},
            edits=True,
        ),
        "critic": Role(
            "Review the actual changes. Accept a justified, general improvement or explain a repair.",
            {
                "type": "object",
                "properties": {
                    "accept": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["accept", "reason"],
                "additionalProperties": False,
            },
        ),
    }

    async def run(self, ctx):
        parent = ctx.inputs.anchor
        baseline = await ctx.evaluate(parent, key="baseline")
        if not baseline.ok:
            return ctx.result(reason="baseline incomplete")
        feedback = {"seed_scores": [cell.score for cell in baseline.evidence]}
        draft = await ctx.workspaces.open(base=parent, key="draft/open")
        for attempt in range(3):
            edit = await ctx.workspaces.edit(
                "editor", workspace=draft, inputs=feedback, key=f"draft/edit/{attempt}"
            )
            if not edit.ok:
                break
            draft = edit.revision
            changes = await ctx.artifacts.diff(parent, draft, key=f"diff/{attempt}")
            review = await ctx.roles.call(
                "critic", inputs=changes, key=f"review/{attempt}"
            )
            if review.ok and review.data["accept"]:
                candidate = await ctx.workspaces.seal(draft, key="draft/seal")
                measured = await ctx.evaluate(candidate, key="candidate")
                if measured.ok and sum(cell.score for cell in measured.evidence) > sum(
                    cell.score for cell in baseline.evidence
                ):
                    return ctx.result(
                        selected=candidate, reason="reviewed seed improvement"
                    )
                return ctx.result(reason="reviewed candidate did not improve seed")
            feedback = review.data
        await ctx.workspaces.discard(draft, key="draft/discard")
        return ctx.result(reason="draft did not pass review")
