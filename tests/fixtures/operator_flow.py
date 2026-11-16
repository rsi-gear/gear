"""Offline end-to-end recipe: read, edit, critic, ensure, confirm, nominate."""

from gear.ops import (
    Algorithm,
    ArtifactInput,
    CandidateRef,
    CallRef,
    CheckEdits,
    Decision,
    EditPlan,
    Evaluate,
    ExecutionInput,
    FileContent,
    FileEdit,
    MaterializeCandidate,
    MaterializeInput,
    Meta,
    MetaInput,
    ReadArtifact,
    SamplePlan,
    TaskSamples,
    Terminal,
    Module,
)
from gear.ops.composition import ScreenVerdict


class ApprovedPredicate(Module):
    def __call__(self, value):
        return ScreenVerdict(
            "allow" if value.critic.get("approved") is True else "reject",
            "critic review",
        )


class OperatorFlow(Algorithm):
    def __init__(
        self,
        reader=None,
        editor=None,
        critic=None,
        evaluator=None,
        edit_check=None,
        predicate=None,
    ):
        self.reader = reader if reader is not None else ReadArtifact()
        self.editor = editor if editor is not None else MaterializeCandidate()
        self.critic = (
            critic
            if critic is not None
            else Meta(
                "Review the sealed change",
                {
                    "type": "object",
                    "properties": {"approved": {"type": "boolean"}},
                    "required": ["approved"],
                    "additionalProperties": False,
                },
                max_tokens=32,
            )
        )
        self.evaluator = evaluator if evaluator is not None else Evaluate()
        self.edit_check = edit_check if edit_check is not None else CheckEdits()
        self.predicate = predicate if predicate is not None else ApprovedPredicate()

    def step(self, view, state):
        phase = state.data.get("phase", 0)
        tasks = tuple(task.id for task in view.tasks)
        data = {}
        if phase == 0:
            call = self.reader(ArtifactInput(view.anchor, "AGENTS.md"), key="read")
        else:
            result = view.results.require(state.data["pending"])
            if result.status != "succeeded":
                return Decision(
                    state,
                    reason="call failed",
                    terminal=Terminal("stop", outcome=result.error),
                )
            if phase == 1:
                assert result.value["complete"]
                call = self.editor(
                    MaterializeInput(
                        view.anchor,
                        EditPlan(
                            (
                                FileEdit(
                                    "replace",
                                    "AGENTS.md",
                                    result.value["content_digest"],
                                    FileContent("Use a verified improved method.\n"),
                                ),
                            )
                        ),
                    ),
                    key="edit",
                )
            elif phase == 2:
                candidate = CandidateRef(**result.value["candidate"])
                data["candidate"] = candidate
                call = self.critic(
                    MetaInput(candidate, tasks, (view.anchor,), {"purpose": "review"}),
                    key="critic",
                )
                data["critic_ref"] = call.ref
            else:
                candidate = CandidateRef(**state.data["candidate"])
                samples = tuple(TaskSamples(task, (0,)) for task in tasks)
                if phase == 3:
                    assert result.value["approved"]
                    call = self.evaluator(
                        ExecutionInput(
                            candidate,
                            SamplePlan(samples),
                            screening=CallRef.parse(state.data["critic_ref"]),
                        ),
                        key="evaluate",
                    )
                elif phase == 4:
                    data["initial_set"] = result.value["ref"]
                    call = self.evaluator(
                        ExecutionInput(
                            candidate,
                            SamplePlan(samples),
                            screening=CallRef.parse(state.data["critic_ref"]),
                        ),
                        key="ensure-again",
                    )
                elif phase == 5:
                    assert result.value["ref"] == state.data["initial_set"]
                    call = self.evaluator(
                        ExecutionInput(
                            candidate,
                            SamplePlan((samples[0],), mode="fresh", plan_id=None),
                            screening=CallRef.parse(state.data["critic_ref"]),
                        ),
                        key="confirmation",
                    )
                else:
                    return Decision(
                        state,
                        reason="confirmed",
                        terminal=Terminal(
                            "nominate", candidate, {"selected": candidate}
                        ),
                    )
        return Decision(
            state.updated(phase=phase + 1, pending=call.ref, **data),
            (call,),
            "advance recipe",
        )
