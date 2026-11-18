"""Composable search policies and flows."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal

from gear.canonical import JSON, digest
from gear.core._json import json_object, json_value
from gear.core.base import Module
from gear.core.calls import CallRef, CandidateRef, Results
from gear.core.candidates import CheckEdits, EditCheck, EditCheckInput
from gear.core.composition import ModuleStep
from gear.core.meta import MetaInput
from gear.evaluation.operators import Evaluate, ExecutionInput


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
