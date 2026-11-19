"""Values exchanged by curriculum operators; execution and storage belong to callers.

References retain the caller's JSON representation. They confer no authority and
are never resolved here. ``dataclasses.asdict`` produces serializable values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from gear.canonical import JSON, digest
from gear.core._json import json_value

Outcome = Literal["success", "failure", "infrastructure_error", "unknown"]
ModeState = Literal["active", "mastered", "unresolved"]
EvidenceKind = Literal["execution", "semantic", "structural"]
REQUIRED_CHECKS = (
    "environment",
    "reference",
    "verifier_calibration",
    "target_fidelity",
    "novelty",
)


@dataclass(frozen=True)
class OutcomeRecord:
    """One normalized attempt, with a caller-namespaced logical sample ID.

    ``passed=None`` means that the caller has no permitted, trustworthy verdict.
    Feedback and instructions must already be authorized generation material.
    """

    task_id: str
    family: str
    sample_id: str
    attempt: int
    policy_id: str
    environment_id: str
    status: Literal["completed", "infrastructure_error", "unknown"]
    passed: bool | None
    complete: bool
    instruction: str = ""
    feedback: str = ""
    evidence_refs: tuple[JSON, ...] = ()
    partition: Literal["train", "validation", "test"] = "train"
    schema_version: int = 1


@dataclass(frozen=True)
class OutcomeCase:
    record: OutcomeRecord
    outcome: Outcome
    schema_version: int = 1

    @property
    def case_id(self) -> str:
        # Retries of one sample are not new failure evidence.
        return digest(
            [
                self.record.sample_id,
                self.record.task_id,
                self.record.policy_id,
                self.record.environment_id,
            ]
        )


@dataclass(frozen=True)
class MasteryObservation:
    mode_id: str
    mastered: bool
    policy_id: str
    evidence_refs: tuple[JSON, ...]
    schema_version: int = 1


@dataclass(frozen=True)
class FailureMode:
    mode_id: str
    description: str
    support_case_ids: tuple[str, ...]
    counterexample_case_ids: tuple[str, ...]
    families: tuple[str, ...]
    diagnoser_id: str
    state: ModeState = "active"
    mastery: MasteryObservation | None = None
    schema_version: int = 1

    @property
    def recurrence(self) -> int:
        return len(set(self.support_case_ids))


@dataclass(frozen=True)
class LearningTarget:
    target_id: str
    description: str
    count: int
    source_case_ids: tuple[str, ...]
    families: tuple[str, ...]
    schema_version: int = 1


@dataclass(frozen=True)
class ModelInput:
    """Prompt, schema and permitted material, not an executable request."""

    prompt: str
    schema: dict[str, JSON]
    data: JSON
    schema_version: int = 1


@dataclass(frozen=True)
class PracticePlan:
    target: LearningTarget
    generator_id: str
    validation_policy_id: str
    conditioning: Literal["failure", "random"] = "failure"
    mutation: str = "Create new instances exercising the target capability."
    kind: Literal["task"] = "task"
    schema_version: int = 1


@dataclass(frozen=True)
class PracticeDraft:
    """Unadmitted task; ``data`` has the caller's task/environment format."""

    draft_id: str
    instruction: str
    family: str
    data: dict[str, JSON]
    reference: JSON
    verifier: JSON
    plan: PracticePlan
    schema_version: int = 1

    @property
    def digest(self) -> str:
        return digest(json_value(self))

    @property
    def content_digest(self) -> str:
        # Ignore new IDs and lineage when checking exact duplicates.
        return digest([self.instruction, self.data, self.reference, self.verifier])


@dataclass(frozen=True)
class ValidationPlan:
    drafts: tuple[PracticeDraft, ...]
    policy_id: str
    validator_id: str
    structural_errors: tuple[tuple[str, str], ...]
    required_checks: tuple[str, ...] = REQUIRED_CHECKS
    schema_version: int = 1


@dataclass(frozen=True)
class ValidationEvidence:
    draft_id: str
    draft_digest: str
    policy_id: str
    validator_id: str
    check: str
    passed: bool | None
    kind: EvidenceKind
    evidence_refs: tuple[JSON, ...]
    detail: str = ""
    schema_version: int = 1


@dataclass(frozen=True)
class CheckResult:
    check: str
    status: Literal["passed", "failed", "missing"]
    kind: EvidenceKind
    evidence_refs: tuple[JSON, ...] = ()
    detail: str = ""


@dataclass(frozen=True)
class ValidationResult:
    draft_id: str
    draft_digest: str
    checks: tuple[CheckResult, ...]

    @property
    def accepted(self) -> bool:
        return (
            len(self.checks) == len(REQUIRED_CHECKS) + 1
            and {item.check for item in self.checks} == {"structure", *REQUIRED_CHECKS}
            and all(item.status == "passed" for item in self.checks)
            and all(item.check == "structure" or item.evidence_refs for item in self.checks)
            and all(
                item.kind == "execution"
                for item in self.checks
                if item.check in ("environment", "reference", "verifier_calibration")
            )
        )


@dataclass(frozen=True)
class ValidationReport:
    policy_id: str
    results: tuple[ValidationResult, ...]
    schema_version: int = 1


@dataclass(frozen=True)
class PracticeSelection:
    draft_id: str
    draft_digest: str
    content_digest: str
    slot: int
    weight: float = 1.0


@dataclass(frozen=True)
class TaskPoolPlan:
    selections: tuple[PracticeSelection, ...]
    rejected: tuple[tuple[str, str], ...]
    base_pool_version: str
    selection_policy_id: str
    schema_version: int = 1


def _version(value: object) -> None:
    version = getattr(value, "schema_version", None)
    if type(version) is not int or version != 1:
        raise ValueError("unsupported curriculum schema version")
    json_value(value)


def _text(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(name + " must be nonempty")


def _unique(values: tuple[str, ...], name: str) -> None:
    for value in values:
        _text(value, name)
    if len(set(values)) != len(values):
        raise ValueError("duplicate " + name)


def _mode(value: FailureMode) -> None:
    _version(value)
    for name in ("mode_id", "description", "diagnoser_id"):
        _text(getattr(value, name), name)
    _unique(value.support_case_ids, "support case")
    _unique(value.counterexample_case_ids, "counterexample case")
    _unique(value.families, "family")
    if not value.support_case_ids or not value.families:
        raise ValueError("failure modes require support and family lineage")
    if set(value.support_case_ids) & set(value.counterexample_case_ids):
        raise ValueError("support and counterexample cases overlap")
    if value.state not in ("active", "mastered", "unresolved"):
        raise ValueError("unknown failure mode state")
    if value.mastery is not None:
        _version(value.mastery)
        _text(value.mastery.policy_id, "mastery policy_id")
        if (
            value.mastery.mode_id != value.mode_id
            or not value.mastery.evidence_refs
            or type(value.mastery.mastered) is not bool
            or value.mastery.mastered != (value.state == "mastered")
        ):
            raise ValueError("mastery must match the mode and its explicit measurement")
    elif value.state == "mastered":
        raise ValueError("mastered modes require measurement evidence")


def _target(value: LearningTarget) -> None:
    _version(value)
    _text(value.target_id, "target_id")
    _text(value.description, "description")
    _unique(value.source_case_ids, "source case")
    _unique(value.families, "family")
    if type(value.count) is not int or value.count < 1 or not value.families:
        raise ValueError("targets require a positive count and family lineage")
