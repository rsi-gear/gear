"""Importable author components used by both SDK and frozen-worker tests."""

from dataclasses import dataclass

from gear.algorithms import AlgorithmState, Decision, Operation
from gear.core import MetaInput, Module
from gear.search import Algorithm, Terminal
from gear.search import Decision as OperatorDecision


@dataclass(frozen=True)
class Scale:
    factor: int = 2

    def __call__(self, value):
        return value * self.factor


def increment(value):
    return value + 1


class Pipeline(Module):
    def __init__(self, steps, metadata=None):
        self.steps = steps
        self.metadata = metadata
        self.runtime_cache = []

    def __call__(self, value):
        for step in self.steps:
            value = step(value)
        return value


class TreeAlgorithm(Module):
    def __init__(self, evaluator, initial=3):
        self.evaluator = evaluator
        self.initial = initial

    def step(self, view, state):
        updated = {
            **state.data,
            "value": self.evaluator(self.initial),
            "steps": state.data.get("steps", 0) + 1,
        }
        return Decision(
            AlgorithmState(data=updated), (Operation("stop"),), "nested tree"
        )


class Empty(Module):
    def __call__(self, value):
        return value


class CriticAlgorithm(Algorithm):
    state_schema_version = 2

    def __init__(self, critic):
        self.critic = critic

    def step(self, view, state):
        if "pending" not in state.data:
            call = self.critic(
                MetaInput(view.anchor, tuple(task.id for task in view.tasks)),
                key="critic",
            )
            return OperatorDecision(state.updated(pending=call.ref), (call,), "inspect")
        result = view.results.require(state.data["pending"])
        return OperatorDecision(
            state.updated(answer=result.value),
            reason="done",
            terminal=Terminal("stop", outcome=result.value),
        )


class ResourceAlgorithm(Algorithm):
    def __init__(self, path):
        self.path = path

    @property
    def source_resources(self):
        return (("prompt", self.path),)

    def step(self, view, state):
        return OperatorDecision(
            state,
            reason="resource read",
            terminal=Terminal("stop", outcome=self.resource("prompt")),
        )


class HiddenCounter(Module):
    def __init__(self):
        self.count = 0

    def __call__(self, value):
        self.count += 1
        return value + self.count


def opens_file(value):
    with open(value) as stream:
        return stream.read()
