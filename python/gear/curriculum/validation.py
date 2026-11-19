"""Pure validation planning and evidence assessment, never task execution."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from gear.canonical import digest
from gear.core.base import Module
from gear.curriculum.contracts import (
    REQUIRED_CHECKS,
    CheckResult,
    PracticeDraft,
    ValidationEvidence,
    ValidationPlan,
    ValidationReport,
    ValidationResult,
    _text,
    _version,
)
from gear.curriculum.generation import _plan


@dataclass
class ValidatePractice(Module):
    """MVP task policy requires a reference and calibrated verifier.

    The caller authenticates evidence and executes against sealed task bytes.
    These structural checks cannot establish provenance or grant admission.
    """

    validator_id: str

    @property
    def identity(self) -> str:
        _text(self.validator_id, "validator_id")
        return digest(self.describe().to_dict())

    def plan(self, drafts: Sequence[PracticeDraft]) -> ValidationPlan:
        errors = []
        seen: set[str] = set()
        for draft in drafts:
            _version(draft)
            _text(draft.draft_id, "draft_id")
            if draft.draft_id in seen:
                raise ValueError("duplicate draft_id")
            seen.add(draft.draft_id)
            if draft.plan.validation_policy_id != self.identity:
                raise ValueError("validation configuration differs from the practice plan")
            try:
                _plan(draft.plan)
                _text(draft.instruction, "instruction")
                if draft.family not in draft.plan.target.families:
                    raise ValueError("draft changed source family lineage")
                if not isinstance(draft.data, dict):
                    raise ValueError("task data must be an object")
                if draft.reference is None or draft.verifier is None:
                    raise ValueError("this validation policy requires a reference and verifier")
            except (TypeError, ValueError) as error:
                errors.append((draft.draft_id, str(error)))
        return ValidationPlan(tuple(drafts), self.identity, self.validator_id, tuple(errors))

    def assess(
        self, plan: ValidationPlan, evidence: Sequence[ValidationEvidence]
    ) -> ValidationReport:
        _version(plan)
        if plan != self.plan(plan.drafts):
            raise ValueError("validation plan or policy changed")
        drafts = {draft.draft_id: draft for draft in plan.drafts}
        errors = dict(plan.structural_errors)
        observations: dict[tuple[str, str], ValidationEvidence] = {}
        for item in evidence:
            _version(item)
            draft = drafts.get(item.draft_id)
            if draft is None or item.check not in plan.required_checks:
                raise ValueError("evidence refers to an unrelated draft or check")
            if item.draft_id in errors:
                raise ValueError("structurally invalid drafts must not be executed")
            if (item.draft_digest, item.policy_id, item.validator_id) != (
                draft.digest,
                plan.policy_id,
                plan.validator_id,
            ):
                raise ValueError("evidence draft, policy or validator identity mismatch")
            if item.passed is not None and type(item.passed) is not bool:
                raise ValueError("evidence verdict must be boolean or unknown")
            if item.kind not in ("execution", "semantic", "structural"):
                raise ValueError("unknown evidence kind")
            if (
                item.check in ("environment", "reference", "verifier_calibration")
                and item.kind != "execution"
            ):
                raise ValueError("this check requires execution evidence")
            key = (item.draft_id, item.check)
            if key in observations:
                raise ValueError("duplicate validation evidence")
            observations[key] = item
        results = []
        for draft in plan.drafts:
            error = errors.get(draft.draft_id)
            checks = [
                CheckResult(
                    "structure", "failed" if error else "passed", "structural", detail=error or ""
                )
            ]
            for name in REQUIRED_CHECKS:
                observation = observations.get((draft.draft_id, name))
                if (
                    observation is None
                    or observation.passed is None
                    or not observation.evidence_refs
                ):
                    checks.append(
                        CheckResult(
                            name,
                            "missing",
                            observation.kind if observation else "execution",
                            detail="complete, referenced evidence required",
                        )
                    )
                else:
                    checks.append(
                        CheckResult(
                            name,
                            "passed" if observation.passed else "failed",
                            observation.kind,
                            observation.evidence_refs,
                            observation.detail,
                        )
                    )
            results.append(ValidationResult(draft.draft_id, draft.digest, tuple(checks)))
        return ValidationReport(plan.policy_id, tuple(results))
