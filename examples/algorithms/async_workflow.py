"""Reflect, edit, and compare using Gear's existing recoverable operations."""

from typing import ClassVar

from gear.algorithms import Role, WorkflowAlgorithm


class ReflectAndEdit(WorkflowAlgorithm):
    roles: ClassVar[dict[str, Role]] = {
        "analyst": Role(
            prompt="Use the supplied seed observations to propose one general improvement.",
            schema={"type": "string"},
        ),
        "editor": Role(
            prompt="Implement the proposed improvement in the allowed candidate files.",
            schema={"type": "string"},
            edits=True,
        ),
    }

    async def run(self, ctx):
        anchor = ctx.inputs.anchor
        baseline = await ctx.evaluate(anchor, key="baseline")
        if not baseline.ok:
            return ctx.result(reason="baseline evidence incomplete")
        diagnosis = await ctx.roles.call(
            "analyst",
            candidate=anchor,
            inputs={"scores": [cell.score for cell in baseline.evidence]},
            key="diagnose",
        )
        if not diagnosis.ok:
            return ctx.result(reason="analysis declined")
        edit = await ctx.roles.call(
            "editor", candidate=anchor, inputs=diagnosis.data, key="edit"
        )
        if not edit.ok:
            return ctx.result(reason="editing declined")
        measured = await ctx.evaluate(edit.candidate, key="candidate")
        before = sum(cell.score for cell in baseline.evidence)
        after = sum(cell.score for cell in measured.evidence) if measured.ok else before
        if after > before:
            return ctx.result(selected=edit.candidate, reason="seed score improved")
        return ctx.result(reason="no complete seed improvement")
