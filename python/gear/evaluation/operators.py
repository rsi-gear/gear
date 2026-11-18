"""Execution, evidence and objective comparisons."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Literal, cast

from gear.canonical import JSON, digest
from gear.core._json import json_object, json_value
from gear.core.base import Module
from gear.core.calls import ArtifactRef, Call, CallRef, CandidateRef, checked_digest, checked_name
from gear.evaluation.objective import (
    aggregate_metrics,
    comparison_key,
    decimal,
    finite,
    numeric,
    score_objective,
    weighted_mean,
)


@dataclass(frozen=True)
class TaskSamples:
    task_id: str
    slots: tuple[int, ...]

    def __post_init__(self) -> None:
        checked_name(self.task_id)
        if (
            not self.slots
            or len(set(self.slots)) != len(self.slots)
            or any(type(slot) is not int or not 0 <= slot < 100000 for slot in self.slots)
        ):
            raise ValueError("sample slots must be nonempty, unique and bounded")


def _tasks(tasks: tuple[TaskSamples, ...]) -> None:
    if not tasks or len(tasks) > 100000 or len({task.task_id for task in tasks}) != len(tasks):
        raise ValueError("sample scope requires nonempty unique tasks")


@dataclass(frozen=True)
class SamplePlan:
    tasks: tuple[TaskSamples, ...]
    mode: Literal["ensure", "fresh", "reuse"] = "ensure"
    plan_id: str | None = "fixed"
    evidence_set: ArtifactRef | None = None
    randomness: Literal["provider", "controlled", "paired"] = "provider"
    seed: str | None = None

    def __post_init__(self) -> None:
        _tasks(self.tasks)
        if self.mode not in ("ensure", "fresh", "reuse") or self.randomness not in (
            "provider",
            "controlled",
            "paired",
        ):
            raise ValueError("unknown sample mode or randomness contract")
        if self.mode == "ensure":
            checked_name(self.plan_id)  # type: ignore[arg-type]
            if self.evidence_set is not None:
                raise ValueError("ensure references a plan, not an evidence set")
        elif self.mode == "fresh":
            if self.plan_id is not None or self.evidence_set is not None:
                raise ValueError("fresh plan identity is assigned from the persisted call")
        elif self.plan_id is not None or self.evidence_set is None:
            raise ValueError("reuse requires an existing evidence set and no new plan")
        if self.randomness == "provider" and self.seed is not None:
            raise ValueError("provider randomness cannot claim a controlled seed")
        if self.randomness != "provider":
            checked_name(self.seed)  # type: ignore[arg-type]


@dataclass(frozen=True)
class ExecutionInput:
    candidate: CandidateRef
    plan: SamplePlan
    assets: tuple[ArtifactRef, ...] = ()
    parameters: JSON = None
    screening: CallRef | None = None


class Evaluate(Module):
    def __init__(self, *, metrics: tuple[str, ...] = ()):
        self.metrics = metrics

    def __call__(self, value: ExecutionInput, *, key: str) -> Call[dict[str, JSON]]:
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "execute",
                "input": {
                    **json_object(value),
                    "mode": "scored",
                    "exposure": "scored",
                    "metrics": json_value(self.metrics),
                },
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("evaluate",)


class Rollout(Module):
    def __init__(
        self,
        *,
        backend: Literal["scored_private", "unscored"] = "scored_private",
        usage_metrics: tuple[str, ...] = (),
    ):
        self.backend = backend
        self.usage_metrics = usage_metrics

    def __call__(self, value: ExecutionInput, *, key: str) -> Call[dict[str, JSON]]:
        if self.backend not in ("scored_private", "unscored"):
            raise ValueError("unsupported rollout backend")
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "execute",
                "input": {
                    **json_object(value),
                    "mode": self.backend,
                    "exposure": "blind",
                    "metrics": json_value(self.usage_metrics),
                },
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("blind_projection", self.backend)


@dataclass(frozen=True)
class ScoreInput:
    execution: ArtifactRef
    scorer: ArtifactRef


class Score(Module):
    def __call__(self, value: ScoreInput, *, key: str) -> Call[dict[str, JSON]]:
        return Call(key, self.operator_ref, {"kind": "score", "input": json_object(value)})

    def requirements(self) -> tuple[str, ...]:
        return ("score_existing",)


@dataclass(frozen=True)
class EvidenceSetSpec:
    candidate: CandidateRef
    assessments: tuple[ArtifactRef, ...]
    tasks: tuple[TaskSamples, ...]
    task_weights: tuple[tuple[str, float], ...]
    objective_ref: str
    reducer_ref: str = "mean-v1"
    missing_policy: Literal["incomplete"] = "incomplete"

    def __post_init__(self) -> None:
        _tasks(self.tasks)
        checked_digest(self.objective_ref)
        _weights(self.tasks, self.task_weights)
        if len({item.digest for item in self.assessments}) != len(self.assessments):
            raise ValueError("duplicate assessment in evidence selection")
        if self.missing_policy != "incomplete":
            raise ValueError("unsupported missing evidence policy")
        checked_name(self.reducer_ref)


def _weights(tasks: tuple[TaskSamples, ...], weights: tuple[tuple[str, float], ...]) -> None:
    if (
        len(dict(weights)) != len(weights)
        or {key for key, _ in weights} != {task.task_id for task in tasks}
        or any(not finite(weight) or weight < 0 for _, weight in weights)
        or not any(weight > 0 for _, weight in weights)
    ):
        raise ValueError("task weights must cover the entire declared scope")


class SelectEvidence(Module):
    """Validate a selection description without resolving references or loading a store."""

    def __call__(self, value: EvidenceSetSpec) -> EvidenceSetSpec:
        # Reconstruct a JSON-independent description to avoid mutable caller aliases.
        return EvidenceSetSpec(
            value.candidate,
            tuple(value.assessments),
            tuple(value.tasks),
            tuple(value.task_weights),
            value.objective_ref,
            value.reducer_ref,
            value.missing_policy,
        )


@dataclass(frozen=True)
class ReadEvidenceInput:
    spec: EvidenceSetSpec
    cursor: str | None = None


class ReadEvidence(Module):
    def __init__(self, *, limit: int = 100):
        self.limit = limit

    def __call__(self, value: ReadEvidenceInput, *, key: str) -> Call[dict[str, JSON]]:
        if type(self.limit) is not int or not 1 <= self.limit <= 1000:
            raise ValueError("invalid evidence page limit")
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "read",
                "input": {"view": "evidence", **json_object(value), "limit": self.limit},
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("evidence_read",)


@dataclass(frozen=True)
class EvidenceRecord:
    sample_id: str
    attempt_id: str
    assessment: ArtifactRef
    task_id: str
    slot: int
    score: float | None
    status: Literal["valid", "task_failed", "scoring_failed", "environment_failed"]
    raw_metrics: JSON = None


@dataclass(frozen=True)
class EvidenceSet:
    ref: ArtifactRef
    spec: EvidenceSetSpec
    records: tuple[EvidenceRecord, ...]
    loaded: bool

    @classmethod
    def from_pages(cls, pages: tuple[JSON, ...]) -> EvidenceSet:
        """Join contiguous ReadEvidence pages; reject gaps, duplicates and mixed snapshots."""
        if not pages or any(not isinstance(page, dict) for page in pages):
            raise ValueError("evidence requires nonempty object pages")
        values = cast(tuple[dict[str, Any], ...], pages)
        first = values[0]
        records: list[dict[str, Any]] = []
        for index, page in enumerate(values):
            if (
                page["ref"] != first["ref"]
                or page["spec"] != first["spec"]
                or page.get("offset", 0) != len(records)
                or page.get("total_records") != first.get("total_records")
                or (page.get("cursor") is None) != (index == len(values) - 1)
                or (page.get("complete") is True) != (index == len(values) - 1)
            ):
                raise ValueError("evidence pages must cover one contiguous complete snapshot")
            records.extend(page["records"])
        if (
            len(records) != first.get("total_records")
            or len({record["sample_id"] for record in records}) != len(records)
            or len({record["assessment"]["digest"] for record in records}) != len(records)
        ):
            raise ValueError("evidence pages have duplicate or missing observations")
        return cls.from_dict(
            json_value({**first, "records": records, "offset": 0, "loaded": True, "cursor": None})
        )

    @classmethod
    def from_dict(cls, value: JSON) -> EvidenceSet:
        if not isinstance(value, dict):
            raise ValueError("evidence result must be an object")
        data = cast(dict[str, Any], value)
        spec = data["spec"]
        description = EvidenceSetSpec(
            CandidateRef(**spec["candidate"]),
            tuple(ArtifactRef(**item) for item in spec["assessments"]),
            tuple(TaskSamples(item["task_id"], tuple(item["slots"])) for item in spec["tasks"]),
            tuple(tuple(item) for item in spec["task_weights"]),
            spec["objective_ref"],
            spec["reducer_ref"],
            spec["missing_policy"],
        )
        if (
            type(data["loaded"]) is not bool
            or data["loaded"]
            and (
                data.get("cursor") is not None
                or data.get("offset", 0) != 0
                or data.get("total_records", len(data["records"])) != len(data["records"])
            )
        ):
            raise ValueError("evidence page cannot claim to be fully loaded")
        return cls(
            ArtifactRef(**data["ref"]),
            description,
            tuple(
                EvidenceRecord(**{**item, "assessment": ArtifactRef(**item["assessment"])})
                for item in data["records"]
            ),
            data["loaded"],
        )


@dataclass(frozen=True)
class ComparisonPlan:
    candidate_refs: tuple[CandidateRef, ...]
    evidence_set_refs: tuple[ArtifactRef, ...]
    task_weights: tuple[tuple[str, float], ...]
    sample_alignment: tuple[TaskSamples, ...]
    objective_ref: str
    reducer_ref: str = "mean-v1"
    missing_policy: Literal["incomplete"] = "incomplete"


@dataclass(frozen=True)
class ComparisonInput:
    plan: ComparisonPlan
    evidence: tuple[EvidenceSet, ...]
    objective: JSON = None
    baseline: CandidateRef | None = None


@dataclass(frozen=True)
class ComparisonResult:
    order: tuple[str, ...]
    scores: tuple[tuple[str, float], ...]
    incomplete: tuple[str, ...]
    unloaded: tuple[str, ...]
    plan_digest: str
    ineligible: tuple[str, ...] = ()


class CompareCandidates(Module):
    """A complete common-scope mean; retries and failed slots never shrink the denominator."""

    def __call__(self, value: ComparisonInput) -> ComparisonResult:
        plan = value.plan
        _tasks(plan.sample_alignment)
        _weights(plan.sample_alignment, plan.task_weights)
        checked_digest(plan.objective_ref)
        if digest(value.objective) != plan.objective_ref:
            raise ValueError("comparison must supply the objective identified by its plan")
        objective = cast(dict[str, Any] | None, value.objective)
        if objective is not None and (
            not isinstance(objective, dict) or set(objective) != {"definition", "metrics"}
        ):
            raise ValueError("comparison objective requires its frozen definition and metrics")
        if value.baseline is not None and value.baseline not in plan.candidate_refs:
            raise ValueError("baseline must belong to the explicit common-scope evidence plan")
        if plan.reducer_ref != "mean-v1" or plan.missing_policy != "incomplete":
            raise ValueError("this comparator only supports mean-v1 with incomplete missing slots")
        if (
            not plan.candidate_refs
            or len(plan.candidate_refs) != len(plan.evidence_set_refs)
            or len({ref.candidate_id for ref in plan.candidate_refs}) != len(plan.candidate_refs)
        ):
            raise ValueError("comparison requires one explicit evidence set per unique candidate")
        sets = {item.ref.digest: item for item in value.evidence}
        if len(sets) != len(value.evidence) or set(sets) != {
            ref.digest for ref in plan.evidence_set_refs
        }:
            raise ValueError("loaded sets do not match the explicit comparison plan")
        scores: list[tuple[str, float]] = []
        incomplete: list[str] = []
        unloaded: list[str] = []
        ineligible: list[str] = []
        aggregates: dict[str, dict[str, Any]] = {}
        slots = {(task.task_id, slot) for task in plan.sample_alignment for slot in task.slots}
        for candidate, reference in zip(plan.candidate_refs, plan.evidence_set_refs):
            item = sets[reference.digest]
            spec = item.spec
            if (
                item.ref != reference
                or spec.candidate != candidate
                or spec.tasks != plan.sample_alignment
                or spec.task_weights != plan.task_weights
                or spec.objective_ref != plan.objective_ref
                or spec.reducer_ref != plan.reducer_ref
                or spec.missing_policy != plan.missing_policy
            ):
                raise ValueError("evidence set is incompatible with the comparison plan")
            cells: dict[tuple[str, int], EvidenceRecord] = {}
            samples: set[str] = set()
            assessments: set[str] = set()
            selected = {ref.digest: ref for ref in spec.assessments}
            for record in item.records:
                key = record.task_id, record.slot
                if (
                    key not in slots
                    or key in cells
                    or record.sample_id in samples
                    or record.assessment.digest in assessments
                    or selected.get(record.assessment.digest) != record.assessment
                ):
                    raise ValueError("unplanned or duplicate sample/assessment in evidence values")
                if record.status not in (
                    "valid",
                    "task_failed",
                    "scoring_failed",
                    "environment_failed",
                ) or (record.score is not None and not finite(record.score)):
                    raise ValueError("invalid evidence observation")
                samples.add(record.sample_id)
                assessments.add(record.assessment.digest)
                cells[key] = record
            if not item.loaded:
                unloaded.append(candidate.candidate_id)
                continue
            if assessments != set(selected):
                raise ValueError("evidence claimed loaded with missing selected assessments")
            if set(cells) != slots or any(
                record.status not in ("valid", "task_failed") or record.score is None
                for record in cells.values()
            ):
                incomplete.append(candidate.candidate_id)
                continue
            if objective is not None:
                raw_records = []
                for record in cells.values():
                    raw = dict(cast(dict[str, Any], record.raw_metrics or {}))
                    pass_rate = next(
                        (
                            contract
                            for contract in objective["metrics"]
                            if contract["id"] == "pass_rate"
                        ),
                        None,
                    )
                    if pass_rate is not None:
                        raw.setdefault(
                            "pass_rate",
                            {
                                "contractDigest": pass_rate["digest"],
                                "unit": pass_rate["unit"],
                                "status": "available",
                                "value": int(record.score == 1),
                                "evidenceRefs": [record.assessment.digest],
                            },
                        )
                    raw_records.append(
                        {
                            "taskId": record.task_id,
                            "repetition": record.slot,
                            "metrics": raw,
                            "digest": record.assessment.digest,
                        }
                    )
                aggregates[candidate.candidate_id] = aggregate_metrics(
                    {
                        "contracts": objective["metrics"],
                        "tasks": [
                            {
                                "id": task.task_id,
                                "weight": dict(plan.task_weights)[task.task_id],
                                "repetitions": list(task.slots),
                            }
                            for task in plan.sample_alignment
                        ],
                        "records": raw_records,
                    }
                )
                continue
            means = []
            weights = dict(plan.task_weights)
            for task in plan.sample_alignment:
                mean = sum(
                    (
                        decimal(cast(float, cells[(task.task_id, slot)].score))
                        for slot in task.slots
                    ),
                    Fraction(),
                ) / len(task.slots)
                means.append((mean, weights[task.task_id]))
            score = numeric(weighted_mean(means))
            if not finite(score):
                raise ValueError("comparison produced a nonfinite score")
            scores.append((candidate.candidate_id, score))
        if objective is not None:
            baseline = aggregates.get(value.baseline.candidate_id) if value.baseline else None
            for candidate_id, metrics in aggregates.items():
                result = score_objective(
                    {
                        "objective": objective["definition"],
                        "metrics": metrics,
                        "baseline": {"metrics": baseline, "digest": digest(baseline)}
                        if baseline is not None
                        else None,
                    }
                )
                if result["status"] != "available":
                    incomplete.append(candidate_id)
                elif any(
                    constraint["status"] == "failed" for constraint in result["constraintResults"]
                ):
                    ineligible.append(candidate_id)
                else:
                    scores.append((candidate_id, result["score"]))

        def ranking(item: tuple[str, float]) -> tuple[int | float, str]:
            score = (
                comparison_key(item[1], objective["definition"]["comparisonPrecision"])
                if objective is not None
                else item[1]
            )
            return -score, item[0]

        return ComparisonResult(
            tuple(key for key, _ in sorted(scores, key=ranking)),
            tuple(scores),
            tuple(incomplete),
            tuple(unloaded),
            digest(json_value(plan)),
            tuple(ineligible),
        )
