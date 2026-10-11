"""A fixed named-step author helper; reducers keep no hidden Python stack state."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import AlgorithmManifest
from gear_algorithm.protocol import AlgorithmDecision, BindingSetRef, OperationIntent, validate_schema
from gear_algorithm.steps import parallel


@dataclass(frozen=True)
class WorkflowStep:
    name: str
    plan: Callable[[dict[str, Any]], Iterable[OperationIntent]]
    join: Callable[[dict[str, Any]], tuple[Any, BindingSetRef | None]]


class Workflow:
    def __init__(self, *, id: str, config_schema: dict[str, Any], binding_schema: dict[str, Any],
                 business_state_schema: dict[str, Any],
                 initial_state: Callable[[dict[str, Any]], Any],
                 steps: Iterable[WorkflowStep]) -> None:
        self.steps = tuple(steps)
        if not self.steps or any(not step.name for step in self.steps) or len({step.name for step in self.steps}) != len(self.steps):
            raise ValidationError("Workflow needs distinct named steps")
        self.business_state_schema = business_state_schema
        self.initial_state = initial_state
        self.manifest = AlgorithmManifest(id=id,
            stateSchema={"type": "object", "properties": {
                "stepIndex": {"type": "integer"}, "business": business_state_schema},
                "required": ["stepIndex", "business"], "additionalProperties": False},
            configSchema=config_schema, bindingSchema=binding_schema)

    def describe(self) -> AlgorithmManifest:
        return self.manifest

    def _plan(self, index: int, business: Any, context: dict[str, Any],
              transition: BindingSetRef | None = None) -> AlgorithmDecision:
        # Empty plans are pure steps. Advance them inside this bounded decision
        # so the host never journals a zero-operation, zero-progress turn.
        while index < len(self.steps):
            step_context = {**context, "state": business,
                "activeBindingSetRef": transition.to_wire() if transition else context["activeBindingSetRef"]}
            operations = parallel(self.steps[index].plan(step_context))
            if operations:
                return AlgorithmDecision(nextState={"stepIndex": index, "business": business},
                                         operations=operations, bindingTransition=transition)
            business, next_transition = self.steps[index].join({**step_context, "completed": {}})
            validate_schema(self.business_state_schema, business)
            if next_transition is not None:
                transition = next_transition
            index += 1
        return AlgorithmDecision(nextState={"stepIndex": index, "business": business},
                                 bindingTransition=transition, complete=True)

    def initialize(self, context: dict[str, Any]) -> AlgorithmDecision:
        state = self.initial_state(context)
        validate_schema(self.business_state_schema, state)
        return self._plan(0, state, context)

    def reduce(self, context: dict[str, Any]) -> AlgorithmDecision:
        state = context["state"]
        if not isinstance(state, dict) or not isinstance(state.get("stepIndex"), int) or not 0 <= state["stepIndex"] < len(self.steps):
            raise ValidationError("Workflow cursor is outside named steps")
        business, transition = self.steps[state["stepIndex"]].join({**context, "state": state["business"]})
        validate_schema(self.business_state_schema, business)
        return self._plan(state["stepIndex"] + 1, business, context, transition)


def define_workflow(**kwargs: Any) -> Workflow:
    """Create a fixed workflow from named plan/join steps and a business schema."""
    return Workflow(**kwargs)
