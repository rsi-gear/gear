"""Archive-guided Agent design with multiple edits of one durable draft."""

from __future__ import annotations

from collections.abc import Sequence
from statistics import mean
from typing import cast

from gear.canonical import JSON

from .contracts import Candidate, Evidence, ResearchRecord
from .run_context import Role, RunContext, WorkflowAlgorithm, WorkflowResult
from .workspaces import WorkspaceRef


class ADAS(WorkflowAlgorithm):
    roles = {
        "designer": Role(
            "Propose a general improvement using the archive in operation.payload.inputs. "
            "Edit the allowed harness files in your working directory. Return a concise design account.",
            {"type": "string"},
            edits=True,
        ),
        "reflector": Role(
            "Reflect on the proposed design in operation.payload.inputs. Inspect the current edited "
            "files and improve them in place. Return the revised design account.",
            {"type": "string"},
            edits=True,
        ),
    }

    def __init__(
        self, max_steps: int = 5, num_reflections: int = 2, selection: str = "dev"
    ) -> None:
        if max_steps < 1 or num_reflections < 0:
            raise ValueError("ADAS requires positive steps and nonnegative reflections")
        if selection not in ("dev", "seed"):
            raise ValueError("ADAS selection must be dev or seed")
        self.configuration = {
            "max_steps": max_steps,
            "num_reflections": num_reflections,
            "selection": selection,
        }
        self.selection = selection
        self.max_steps, self.num_reflections = max_steps, num_reflections

    async def run(self, ctx: RunContext) -> WorkflowResult:
        tasks = ctx.data.dev if self.selection == "dev" else ctx.data.seed
        if not tasks:
            raise ValueError("ADAS requires a nonempty selection dataset")

        async def score(candidate: Candidate, key: str) -> float:
            evidence: Sequence[Evidence]
            if self.selection == "dev":
                trials = await ctx.measure(candidate, tasks=tasks, group=key, key=key)
                evidence = [row.evidence for row in trials.observations]
                ok = trials.ok
            else:
                measured = await ctx.evaluate(candidate, tasks=tasks, key=key)
                evidence = measured.evidence
                ok = measured.ok
            if not ok:
                raise ValueError("ADAS selection requires complete scored observations")
            return mean(cast(float, row.score) for row in evidence)

        best = ctx.inputs.anchor
        best_score = await score(best, "baseline")
        archive: list[dict[str, JSON]] = [
            {"candidate_id": best.id, "account": "initial harness", "score": best_score}
        ]
        declined: list[dict[str, JSON]] = []
        for step in range(self.max_steps):
            if ctx.budget.snapshot(key=f"{step}/budget").candidates_remaining == 0:
                break
            material = await ctx.artifacts.material(cast(JSON, archive), key=f"{step}/history")
            draft = await ctx.workspaces.open(base=best, key=f"{step}/open")
            account = ""
            valid = True
            for edit_index in range(self.num_reflections + 1):
                edit = await ctx.roles.call(
                    "designer" if edit_index == 0 else "reflector",
                    workspace=draft,
                    materials={"archive": material},
                    inputs=cast(
                        JSON,
                        {"step": step, "edit": edit_index, "archive": archive, "account": account},
                    ),
                    key=f"{step}/edit/{edit_index}",
                )
                if not edit.ok:
                    valid = False
                    declined.append({"step": step, "edit": edit_index, "reason": edit.data})
                    break
                draft, account = cast(WorkspaceRef, edit.revision), str(edit.data)
            if not valid:
                await ctx.workspaces.discard(draft, key=f"{step}/discard")
                continue
            try:
                candidate = await ctx.workspaces.seal(draft, key=f"{step}/seal")
            except ValueError as error:
                declined.append({"step": step, "reason": str(error)})
                await ctx.workspaces.discard(draft, key=f"{step}/discard")
                continue
            value = await score(candidate, f"{step}/selection")
            archive.append({"candidate_id": candidate.id, "account": account, "score": value})
            accepted = value > best_score
            ctx.record(
                ResearchRecord(
                    "ranking",
                    "global",
                    tuple(t.id for t in tasks),
                    (best.id, candidate.id),
                    cast(
                        JSON,
                        {
                            "step": step,
                            "accepted": accepted,
                            "parent_score": best_score,
                            "candidate_score": value,
                            "account": account,
                        },
                    ),
                ),
                key=f"{step}/decision",
            )
            if accepted:
                best, best_score = candidate, value
        ctx.record(
            ResearchRecord(
                "ranking",
                "global",
                tuple(t.id for t in tasks),
                tuple(cast(str, row["candidate_id"]) for row in archive),
                cast(JSON, {"archive": archive, "declined": declined}),
            ),
            key="archive",
        )
        return ctx.result(
            selected=best,
            data=cast(JSON, {"archive": archive, "declined": declined, "score": best_score}),
            reason="ADAS design archive complete",
        )
