"""Semantic supervision proposals, before trusted training-data admission.

The caller supplies normalized, authorized facts and independent verification.
This module never resolves references, captures tokens, or proves authority from
an arbitrary reference. Training builders must verify the original artifacts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from gear.canonical import JSON, digest
from gear.core._json import json_value
from gear.core.base import Module
from gear.curriculum.cases import _cases
from gear.curriculum.contracts import OutcomeCase, _text, _version

MaterialProtocol = Literal["feedback_only", "verified_reference", "gold_answer_allowed"]
PROTOCOLS = ("feedback_only", "verified_reference", "gold_answer_allowed")


@dataclass(frozen=True)
class SupervisionTrace:
    case: OutcomeCase
    trajectory_ref: JSON
    initial_state_ref: JSON
    steps: int
    material_protocol: MaterialProtocol = "feedback_only"
    final_state_ref: JSON = None
    schema_version: int = 1

    @property
    def digest(self) -> str:
        return digest(json_value(self))


@dataclass(frozen=True)
class TrajectoryVerification:
    trace_digest: str
    kind: Literal["success", "prefix"]
    through_step: int
    evidence_refs: tuple[JSON, ...]
    verifier_id: str
    verified: bool = True
    schema_version: int = 1


@dataclass(frozen=True)
class SFTSupervision:
    trace: SupervisionTrace
    verification: TrajectoryVerification
    schema_version: int = 1


@dataclass(frozen=True)
class RepairVerification:
    failure_digest: str
    revised_digest: str
    mode: Literal["verified_replay", "checkpoint_reset", "terminal_continue"]
    start_state_ref: JSON
    evidence_refs: tuple[JSON, ...]
    verifier_id: str
    verified: bool = True
    schema_version: int = 1


@dataclass(frozen=True)
class RepairSupervision:
    failure: SupervisionTrace
    revised: SupervisionTrace
    loss_start_step: int
    execution: RepairVerification
    verification: TrajectoryVerification
    schema_version: int = 1


@dataclass(frozen=True)
class PreferenceJudgment:
    chosen_digest: str
    rejected_digest: str
    label_source: Literal["independent_verifier", "human", "majority_vote"]
    evidence_refs: tuple[JSON, ...]
    confidence: float | None = None
    schema_version: int = 1


@dataclass(frozen=True)
class PreferenceSupervision:
    chosen: SupervisionTrace
    rejected: SupervisionTrace
    judgment: PreferenceJudgment
    scope: Literal["trajectory", "step"] = "trajectory"
    chosen_prefix_ref: JSON = None
    rejected_prefix_ref: JSON = None
    schema_version: int = 1


@dataclass(frozen=True)
class ProceduralExample:
    case: OutcomeCase
    question: str
    answer: str
    validation_refs: tuple[JSON, ...]
    material_protocol: MaterialProtocol = "feedback_only"
    schema_version: int = 1


@dataclass(frozen=True)
class ProceduralSupervision:
    examples: tuple[ProceduralExample, ...]
    schema_version: int = 1


@dataclass(frozen=True)
class SupervisionSpan:
    """Half-open semantic step range; the training builder maps it to tokens."""

    trajectory_ref: JSON
    start_step: int
    stop_step: int
    loss: bool


@dataclass(frozen=True)
class PreferenceRelation:
    chosen_ref: JSON
    rejected_ref: JSON
    scope: Literal["trajectory", "step"]
    initial_state_ref: JSON
    decision_prefix_ref: JSON = None


@dataclass(frozen=True)
class SupervisionProposal:
    kind: Literal["sft_success", "sft_prefix", "repair_sft", "preference", "synthetic_procedural"]
    source_case_ids: tuple[str, ...]
    spans: tuple[SupervisionSpan, ...]
    evidence_refs: tuple[JSON, ...]
    material_protocols: tuple[MaterialProtocol, ...]
    label_source: str
    preference: PreferenceRelation | None = None
    examples: tuple[ProceduralExample, ...] = ()
    confidence: float | None = None
    schema_version: int = 1


def _reference(value: JSON) -> None:
    json_value(value)
    if not isinstance(value, (str, dict)) or not value:
        raise ValueError("a nonempty caller-owned evidence/state reference is required")


def _references(values: tuple[JSON, ...]) -> None:
    if not values:
        raise ValueError("independent verification evidence is required")
    for value in values:
        _reference(value)


def _trace(value: SupervisionTrace, allowed: tuple[MaterialProtocol, ...]) -> None:
    _version(value)
    _cases((value.case,))
    if value.material_protocol not in allowed:
        raise ValueError("material protocol is outside the caller's explicit grant")
    _reference(value.trajectory_ref)
    _reference(value.initial_state_ref)
    if type(value.steps) is not int or value.steps < 1:
        raise ValueError("trace requires a positive semantic step count")
    if value.final_state_ref is not None:
        _reference(value.final_state_ref)


def _verified(trace: SupervisionTrace, proof: TrajectoryVerification) -> None:
    _version(proof)
    _text(proof.verifier_id, "verifier_id")
    _references(proof.evidence_refs)
    if (
        proof.verified is not True
        or proof.trace_digest != trace.digest
        or proof.kind not in ("success", "prefix")
        or type(proof.through_step) is not int
        or not 0 < proof.through_step <= trace.steps
    ):
        raise ValueError("verification must bind the exact trace and selected step range")
    if proof.kind == "success" and (
        proof.through_step != trace.steps
        or trace.case.outcome != "success"
        or not trace.case.record.complete
    ):
        raise ValueError("success supervision requires an independently verified complete success")


class BuildSupervision(Module):
    """Construct proposals; caller grants cannot be expanded by request fields.

    `allowed_protocols` is supplied by the trusted caller after authorization.
    It is not a capability token. The downstream builder resolves and rechecks
    artifacts, masks and comparisons under the host's actual access policy.
    """

    def __call__(
        self,
        request: SFTSupervision | RepairSupervision | PreferenceSupervision | ProceduralSupervision,
        *,
        allowed_protocols: tuple[MaterialProtocol, ...] = ("feedback_only",),
    ) -> SupervisionProposal:
        if (
            not allowed_protocols
            or len(set(allowed_protocols)) != len(allowed_protocols)
            or any(value not in PROTOCOLS for value in allowed_protocols)
        ):
            raise ValueError("caller material grants must be explicit known protocols")
        _version(request)
        if isinstance(request, SFTSupervision):
            trace, proof = request.trace, request.verification
            _trace(trace, allowed_protocols)
            _verified(trace, proof)
            return SupervisionProposal(
                "sft_success" if proof.kind == "success" else "sft_prefix",
                (trace.case.case_id,),
                (SupervisionSpan(trace.trajectory_ref, 0, proof.through_step, True),),
                proof.evidence_refs,
                (trace.material_protocol,),
                "independent_verifier",
            )
        if isinstance(request, RepairSupervision):
            return self._repair(request, allowed_protocols)
        if isinstance(request, PreferenceSupervision):
            return self._preference(request, allowed_protocols)
        if not isinstance(request, ProceduralSupervision) or not request.examples:
            raise ValueError("unsupported or empty supervision request")
        cases: list[str] = []
        protocols: set[MaterialProtocol] = set()
        evidence: list[JSON] = []
        seen: set[str] = set()
        for example in request.examples:
            _version(example)
            _cases((example.case,))
            _text(example.question, "question")
            _text(example.answer, "answer")
            _references(example.validation_refs)
            if example.material_protocol not in allowed_protocols:
                raise ValueError("synthetic example uses unauthorized material")
            identity = digest([example.question, example.answer])
            if identity in seen:
                raise ValueError("duplicate synthetic procedural example")
            seen.add(identity)
            cases.append(example.case.case_id)
            protocols.add(example.material_protocol)
            evidence.extend(example.validation_refs)
        return SupervisionProposal(
            "synthetic_procedural",
            tuple(sorted(set(cases))),
            (),
            tuple(evidence),
            tuple(sorted(protocols)),
            "synthetic",
            examples=request.examples,
        )

    @staticmethod
    def _repair(
        value: RepairSupervision, allowed: tuple[MaterialProtocol, ...]
    ) -> SupervisionProposal:
        failure, revised, proof = value.failure, value.revised, value.execution
        _trace(failure, allowed)
        _trace(revised, allowed)
        _verified(revised, value.verification)
        _version(proof)
        _text(proof.verifier_id, "verifier_id")
        _references(proof.evidence_refs)
        _reference(proof.start_state_ref)
        if (
            failure.case.outcome != "failure"
            or not failure.case.record.complete
            or value.verification.kind != "success"
            or (failure.case.record.task_id, failure.case.record.environment_id)
            != (revised.case.record.task_id, revised.case.record.environment_id)
            or failure.trajectory_ref == revised.trajectory_ref
        ):
            raise ValueError(
                "repair needs a failed source and separately captured successful execution"
            )
        if (
            proof.verified is not True
            or proof.failure_digest != failure.digest
            or proof.revised_digest != revised.digest
            or proof.start_state_ref != revised.initial_state_ref
            or proof.mode not in ("verified_replay", "checkpoint_reset", "terminal_continue")
        ):
            raise ValueError(
                "repair execution proof must bind the exact source, capture and start state"
            )
        if proof.mode == "verified_replay" and proof.start_state_ref != failure.initial_state_ref:
            raise ValueError("replay must start from the source's original state")
        if proof.mode == "terminal_continue" and (
            failure.final_state_ref is None or proof.start_state_ref != failure.final_state_ref
        ):
            raise ValueError("continuation must start from the actual failed terminal state")
        # For checkpoint_reset, the proof attests that this exact checkpoint is
        # restorable from the failed execution; the caller must execute that check.
        start = value.loss_start_step
        if type(start) is not int or not 0 <= start < revised.steps:
            raise ValueError("repair loss boundary must leave a nonempty captured suffix")
        spans: tuple[SupervisionSpan, ...] = (
            () if start == 0 else (SupervisionSpan(revised.trajectory_ref, 0, start, False),)
        )
        spans += (SupervisionSpan(revised.trajectory_ref, start, revised.steps, True),)
        return SupervisionProposal(
            "repair_sft",
            (failure.case.case_id, revised.case.case_id),
            spans,
            (*proof.evidence_refs, *value.verification.evidence_refs),
            tuple(sorted({failure.material_protocol, revised.material_protocol})),
            "independent_verifier",
        )

    @staticmethod
    def _preference(
        value: PreferenceSupervision, allowed: tuple[MaterialProtocol, ...]
    ) -> SupervisionProposal:
        chosen, rejected, proof = value.chosen, value.rejected, value.judgment
        _trace(chosen, allowed)
        _trace(rejected, allowed)
        _version(proof)
        _references(proof.evidence_refs)
        if (
            value.scope not in ("trajectory", "step")
            or proof.chosen_digest != chosen.digest
            or proof.rejected_digest != rejected.digest
            or chosen.trajectory_ref == rejected.trajectory_ref
            or (
                chosen.case.record.task_id,
                chosen.case.record.environment_id,
                chosen.initial_state_ref,
            )
            != (
                rejected.case.record.task_id,
                rejected.case.record.environment_id,
                rejected.initial_state_ref,
            )
        ):
            raise ValueError(
                "preference traces must bind distinct captures of the same task and start conditions"
            )
        if proof.label_source not in ("independent_verifier", "human", "majority_vote"):
            raise ValueError("unknown preference label source")
        if proof.confidence is not None and (
            type(proof.confidence) not in (int, float)
            or not math.isfinite(proof.confidence)
            or not 0 <= proof.confidence <= 1
        ):
            raise ValueError("preference confidence must be finite and in [0, 1]")
        if value.scope == "step":
            _reference(value.chosen_prefix_ref)
            if value.chosen_prefix_ref != value.rejected_prefix_ref:
                raise ValueError("step preference requires the same decision prefix/state")
        elif value.chosen_prefix_ref is not None or value.rejected_prefix_ref is not None:
            raise ValueError("trajectory preference does not take step prefix references")
        elif not chosen.case.record.complete or not rejected.case.record.complete:
            raise ValueError("trajectory preferences require complete executions")
        return SupervisionProposal(
            "preference",
            (chosen.case.case_id, rejected.case.case_id),
            (),
            proof.evidence_refs,
            tuple(sorted({chosen.material_protocol, rejected.material_protocol})),
            proof.label_source,
            preference=PreferenceRelation(
                chosen.trajectory_ref,
                rejected.trajectory_ref,
                value.scope,
                chosen.initial_state_ref,
                value.chosen_prefix_ref,
            ),
            confidence=proof.confidence,
        )
