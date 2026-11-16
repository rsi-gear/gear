"""A real critic/check/evaluate flow with explicit resumable child state.

The predicate and edit budget are examples; RRSI-specific costs and component
classification belong in the recipe, not in Gear's execution layer.
"""

from gear.core import (
    ApplyInput,
    ArtifactInput,
    CandidateRef,
    CheckEdits,
    EditCheckInput,
    EditPlan,
    FileContent,
    FileEdit,
    MaterializeCandidate,
    MaterializeInput,
    Meta,
    ReadArtifact,
)
from gear.evaluation import ExecutionInput, SamplePlan, TaskSamples
from gear.search import Algorithm, Decision, ScreenedEvaluate, ScreenInput, Terminal


class ScreenedChange(Algorithm):
    def __init__(
        self,
        text="Check each requirement before returning the answer.\n",
        screen=None,
        reader=None,
        editor=None,
    ):
        self.text = text
        self.screen = (
            screen
            if screen is not None
            else ScreenedEvaluate(
                critic=Meta(
                    "Review the sealed candidate and exact edit. Decide allow, reject, or insufficient_evidence.",
                    {
                        "type": "object",
                        "properties": {
                            "status": {
                                "enum": ["allow", "reject", "insufficient_evidence"]
                            },
                            "reason": {"type": "string"},
                        },
                        "required": ["status", "reason"],
                        "additionalProperties": False,
                    },
                ),
                edit_check=CheckEdits(
                    allowed_paths=("AGENTS.md",), max_files=1, max_changed_bytes=65536
                ),
            )
        )
        self.reader = reader if reader is not None else ReadArtifact()
        self.editor = editor if editor is not None else MaterializeCandidate()

    def step(self, view, state):
        phase = state.data.get("phase", 0)
        if phase == 0:
            call = self.reader(ArtifactInput(view.anchor, "AGENTS.md"), key="original")
            return Decision(
                state.updated(phase=1, pending=call.ref),
                (call,),
                "read exact edit context",
            )
        if phase in (1, 2):
            result = view.results.require(state.data["pending"])
            if result.status != "succeeded":
                return Decision(
                    state,
                    reason="material failed",
                    terminal=Terminal("stop", outcome=result.error),
                )
            if phase == 1:
                if not result.value["complete"]:
                    return Decision(
                        state,
                        reason="example material exceeds one page",
                        terminal=Terminal("stop"),
                    )
                before = FileContent(result.value["content"], encoding="base64")
                plan = EditPlan(
                    (
                        FileEdit(
                            "replace",
                            "AGENTS.md",
                            before.digest,
                            FileContent(self.text),
                        ),
                    )
                )
                call = self.editor(
                    MaterializeInput(view.anchor, plan), key="exact-change"
                )
                return Decision(
                    state.updated(phase=2, pending=call.ref, before=before),
                    (call,),
                    "seal exact candidate",
                )
            state = state.updated(phase=3, candidate=result.value["candidate"])
        before = FileContent(**state.data["before"])
        candidate = CandidateRef(**state.data["candidate"])
        plan = EditPlan(
            (FileEdit("replace", "AGENTS.md", before.digest, FileContent(self.text)),)
        )
        result = self.screen(
            ScreenInput(
                ExecutionInput(
                    candidate,
                    SamplePlan(
                        tuple(TaskSamples(task.id, (0,)) for task in view.tasks)
                    ),
                ),
                EditCheckInput(ApplyInput({"AGENTS.md": before}, plan)),
            ),
            view=view,
            state=state.data.get("screen"),
            key="screen",
        )
        if result.done:
            # Internal acceptance is an outcome only; no champion nomination here.
            return Decision(
                state,
                reason="screening completed",
                terminal=Terminal("stop", outcome=result.result),
                records=(
                    {
                        "kind": "screened",
                        "candidate": candidate,
                        "result": result.result,
                    },
                ),
            )
        return Decision(
            state.updated(screen=result.state), result.calls, "advance screen"
        )
