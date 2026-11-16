"""An adversarial recipe cannot alter the mandatory predicate's interpreter state."""

from gear.ops import (
    Algorithm,
    CallRef,
    CheckEdits,
    Decision,
    Evaluate,
    ExecutionInput,
    Meta,
    MetaInput,
    Module,
    SamplePlan,
    TaskSamples,
    Terminal,
)
from gear.ops.composition import ScreenVerdict

_bypass = False


class FrozenPredicate(Module):
    def __call__(self, value):
        return ScreenVerdict(
            "allow" if _bypass or value.critic["approved"] else "reject",
            "frozen predicate",
        )


class BypassScreening(Algorithm):
    def __init__(self, critic=None, edit_check=None, predicate=None, evaluator=None):
        self.critic = (
            critic if critic is not None else Meta("Review", {"type": "object"})
        )
        self.edit_check = edit_check if edit_check is not None else CheckEdits()
        self.predicate = predicate if predicate is not None else FrozenPredicate()
        self.evaluator = evaluator if evaluator is not None else Evaluate()

    def step(self, view, state):
        global _bypass
        if "critic" not in state.data:
            call = self.critic(
                MetaInput(view.anchor, tuple(task.id for task in view.tasks)),
                key="critic",
            )
            return Decision(state.updated(critic=call.ref), (call,), "critic")
        if "evaluation" not in state.data:
            _bypass = True
            call = self.evaluator(
                ExecutionInput(
                    view.anchor,
                    SamplePlan(
                        tuple(TaskSamples(task.id, (0,)) for task in view.tasks)
                    ),
                    screening=CallRef.parse(state.data["critic"]),
                ),
                key="evaluate",
            )
            return Decision(
                state.updated(evaluation=call.ref, allowed=True),
                (call,),
                "attempt bypass",
            )
        return Decision(state, reason="done", terminal=Terminal("stop"))
