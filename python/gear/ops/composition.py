"""Pure composition and an explicitly checkpointed screening/evaluation flow."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, replace
from typing import Any, Generic, Literal, Protocol, TypeVar

from gear.algorithms.contracts import ParentOption, RandomSource, Selection
from gear.canonical import JSON, digest

from ._json import json_object, json_value
from .base import Module
from .calls import Call, CallRef, CandidateRef, Results
from .candidates import CheckEdits, EditCheck, EditCheckInput
from .evaluation import Evaluate, ExecutionInput
from .meta import MetaInput

ResultT = TypeVar("ResultT")
InputT = TypeVar("InputT", contravariant=True)


@dataclass(frozen=True)
class ModuleStep(Generic[ResultT]):
    state: JSON
    calls: tuple[Call[Any], ...] = ()
    done: bool = False
    result: ResultT | None = None

    def __post_init__(self) -> None:
        json_value(self.state)
        if self.done == bool(self.calls) or not self.done and self.result is not None:
            raise ValueError("module step must finish or expose a nonempty pending call batch")


class StepModule(Protocol[InputT, ResultT]):
    def __call__(
        self, value: InputT, *, view: Any, state: JSON, key: str
    ) -> ModuleStep[ResultT]: ...


class Sequential(Module):
    def __init__(self, steps: tuple[Any, ...]):
        self.steps = steps

    def __call__(self, value: Any, *, rng: RandomSource | None = None) -> Any:
        for index, step in enumerate(self.steps):
            parameters = inspect.signature(step).parameters
            child_rng = ScopedRandom(rng, f"steps/{index}") if rng is not None else None
            value = step(value, rng=child_rng) if "rng" in parameters else step(value)
            if isinstance(value, Call) or inspect.isawaitable(value):
                raise TypeError("Sequential only composes immediate pure computations")
        return value


class ScopedRandom:
    """Child draws use an explicit namespace and never consume a shared cursor."""

    def __init__(self, parent: RandomSource, path: str):
        self.parent = parent
        self.path = path

    def value(self, key: str, index: int = 0) -> float:
        return self.parent.value(digest([self.path, key]), index)

    def choice(self, options: tuple[ParentOption, ...], *, key: str, index: int = 0) -> Selection:
        return self.parent.choice(options, key=digest([self.path, key]), index=index)


@dataclass(frozen=True)
class ScreenCheckInput:
    candidate: CandidateRef
    edits: EditCheck
    critic: JSON


@dataclass(frozen=True)
class ScreenVerdict:
    status: Literal["allow", "reject", "insufficient_evidence"]
    reason: str

    def __post_init__(self) -> None:
        if (
            self.status not in ("allow", "reject", "insufficient_evidence")
            or not self.reason.strip()
        ):
            raise ValueError("screening requires an explicit verdict and reason")


class InterpretScreen(Module):
    """A conservative default; recipes can replace it with their own frozen predicate."""

    def __call__(self, value: ScreenCheckInput) -> ScreenVerdict:
        if value.edits.status != "allow":
            return ScreenVerdict(value.edits.status, value.edits.reason)
        if value.critic is None:
            return ScreenVerdict("allow", "static edit check passed")
        reason = value.critic.get("reason") if isinstance(value.critic, dict) else None
        if (
            not isinstance(value.critic, dict)
            or value.critic.get("status") not in ("allow", "reject", "insufficient_evidence")
            or not isinstance(reason, str)
            or not reason.strip()
        ):
            return ScreenVerdict(
                "insufficient_evidence", "critic response lacks an explicit verdict"
            )
        return ScreenVerdict(value.critic["status"], reason)  # type: ignore[arg-type]


@dataclass(frozen=True)
class ScreenInput:
    execution: ExecutionInput
    edits: EditCheckInput


@dataclass(frozen=True)
class ScreenResult:
    status: Literal["screened", "evaluated", "evaluation_failed"]
    candidate: CandidateRef
    verdict: ScreenVerdict
    evaluation: JSON = None
    screening_receipt: CallRef | None = None


class ScreenedEvaluate(Module):
    def __init__(
        self, critic: Any = None, check: Any = None, evaluator: Any = None, edit_check: Any = None
    ):
        self.critic = critic
        self.check = InterpretScreen() if check is None else check
        self.evaluator = Evaluate() if evaluator is None else evaluator
        self.edit_check = CheckEdits() if edit_check is None else edit_check

    def __call__(
        self, value: ScreenInput, *, view: Any, state: JSON = None, key: str
    ) -> ModuleStep[ScreenResult]:
        results: Results = view.results
        identity = digest(json_value(value))
        current = {} if state is None else json_object(state)
        if current and (current.get("version") != 1 or current.get("input_digest") != identity):
            raise ValueError("screening module input or state version changed")
        phase = current.get("phase", "check")
        receipt: CallRef | None = None
        if phase == "check":
            edits = self.edit_check(value.edits)
            if not isinstance(edits, EditCheck):
                raise TypeError("edit checker must return EditCheck")
            if edits.status != "allow":
                verdict = ScreenVerdict(edits.status, edits.reason)
                return ModuleStep(
                    {},
                    done=True,
                    result=ScreenResult("screened", value.execution.candidate, verdict),
                )
            if self.critic is not None:
                call = self.critic(
                    MetaInput(
                        value.execution.candidate,
                        tuple(task.task_id for task in value.execution.plan.tasks),
                        data=json_object(value.edits),
                    ),
                    key=key + "/critic",
                )
                return ModuleStep(
                    {
                        "version": 1,
                        "phase": "critic",
                        "input_digest": identity,
                        "pending": json_value(call.ref),
                        "edits": json_value(edits),
                    },
                    (call,),
                )
            verdict = self.check(ScreenCheckInput(value.execution.candidate, edits, None))
        elif phase == "critic":
            receipt = CallRef.parse(current["pending"])  # type: ignore[arg-type]
            result = results.require(receipt)
            edits = EditCheck(**current["edits"])  # type: ignore[arg-type]
            verdict = (
                self.check(ScreenCheckInput(value.execution.candidate, edits, result.value))
                if result.status == "succeeded"
                else ScreenVerdict("insufficient_evidence", "critic call did not succeed")
            )
        elif phase == "evaluate":
            pending = CallRef.parse(current["pending"])  # type: ignore[arg-type]
            evaluation = results.require(pending)
            verdict = ScreenVerdict(**current["verdict"])  # type: ignore[arg-type]
            receipt = (
                CallRef.parse(json_object(current["screening_receipt"]))
                if current["screening_receipt"] is not None
                else None
            )
            return ModuleStep(
                {},
                done=True,
                result=ScreenResult(
                    "evaluated" if evaluation.status == "succeeded" else "evaluation_failed",
                    value.execution.candidate,
                    verdict,
                    json_value(evaluation.value),
                    receipt,
                ),
            )
        else:
            raise ValueError("unknown screening phase")
        if not isinstance(verdict, ScreenVerdict):
            raise TypeError("screening predicate must return ScreenVerdict")
        if verdict.status != "allow":
            return ModuleStep(
                {},
                done=True,
                result=ScreenResult(
                    "screened", value.execution.candidate, verdict, screening_receipt=receipt
                ),
            )
        call = self.evaluator(
            replace(value.execution, screening=receipt or value.execution.screening),
            key=key + "/evaluate",
        )
        return ModuleStep(
            {
                "version": 1,
                "phase": "evaluate",
                "input_digest": identity,
                "pending": json_value(call.ref),
                "verdict": json_value(verdict),
                "screening_receipt": json_value(receipt),
            },
            (call,),
        )
