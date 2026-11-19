"""DiagEvo-specific curriculum rules, not a registered end-to-end trainer.

The caller owns sampling, answer equivalence, diagnosis/retrieval, model updates
and persistence. A majority label and a Mastered state express self-consistency,
never external correctness. No rule here manufactures native training receipts.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Literal

from gear.core import Module
from gear.core.random import RandomSource


@dataclass(frozen=True)
class SolverSample:
    sample_id: str
    question_id: str
    policy_id: str
    phase: Literal["construction", "optimization"]
    answer_key: str
    trajectory_ref: str
    completed: bool = True


@dataclass(frozen=True)
class ConstructionVote:
    question_id: str
    policy_id: str
    samples: tuple[SolverSample, ...]
    answer_key: str
    reference_sample_id: str
    p1: float
    p2: float
    retained: bool
    label_source: Literal["majority_vote"] = "majority_vote"


@dataclass(frozen=True)
class OptimizationGroup:
    vote: ConstructionVote
    samples: tuple[SolverSample, ...]
    rewards: tuple[int, ...]


@dataclass(frozen=True)
class Cause:
    cause_id: str
    node_id: str
    description: str
    state: Literal["active", "mastered"]
    episode_failure_ids: tuple[str, ...]
    failure_ids: tuple[str, ...]

    @property
    def frequency(self) -> int:
        return len(self.episode_failure_ids)


@dataclass(frozen=True)
class GenerationDirective:
    mode: Literal["free", "targeted", "stitched"]
    cause_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class FailureAttribution:
    sample_id: str
    cause_id: str
    node_id: str
    description: str
    evidence_refs: tuple[str, ...]


def _text(value: str) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _unique(values: Sequence[str]) -> bool:
    return all(_text(value) for value in values) and len(set(values)) == len(values)


def _memory(memory: Sequence[Cause]) -> dict[str, Cause]:
    causes: dict[str, Cause] = {}
    failures: set[str] = set()
    for cause in memory:
        if (
            not all(_text(value) for value in (cause.cause_id, cause.node_id, cause.description))
            or cause.cause_id in causes
            or cause.state not in ("active", "mastered")
            or not _unique(cause.episode_failure_ids)
            or not _unique(cause.failure_ids)
            or not cause.failure_ids
            or not set(cause.episode_failure_ids) <= set(cause.failure_ids)
            or bool(cause.episode_failure_ids) != (cause.state == "active")
            or failures.intersection(cause.failure_ids)
        ):
            raise ValueError("invalid cause state, active episode, or repeated failure identity")
        causes[cause.cause_id] = cause
        failures.update(cause.failure_ids)
    return causes


def _samples(samples: Sequence[SolverSample], count: int, phase: str) -> tuple[SolverSample, ...]:
    values = tuple(samples)
    if (
        len(values) != count
        or not _unique([sample.sample_id for sample in values])
        or len({sample.question_id for sample in values}) != 1
        or len({sample.policy_id for sample in values}) != 1
        or any(
            sample.completed is not True
            or sample.phase != phase
            or not all(
                _text(value)
                for value in (
                    sample.question_id,
                    sample.policy_id,
                    sample.answer_key,
                    sample.trajectory_ref,
                )
            )
            for sample in values
        )
    ):
        raise ValueError("responses must be complete, distinct, and from one question/policy/phase")
    return values


@dataclass
class DiagEvoPolicy(Module):
    construction_samples: int = 12
    optimization_group_size: int = 8
    p_low: float = 0.25
    p_high: float = 0.75
    relative_confidence: float = 1.6
    promotion_threshold: float = 0.7
    exploration_k: float = 0.5

    def _parameters(self) -> None:
        if any(
            type(value) is not int or value < 2
            for value in (self.construction_samples, self.optimization_group_size)
        ):
            raise ValueError("construction and optimization groups require at least two samples")
        values = (
            self.p_low,
            self.p_high,
            self.relative_confidence,
            self.promotion_threshold,
            self.exploration_k,
        )
        if (
            any(type(value) not in (int, float) or not math.isfinite(value) for value in values)
            or not 0 <= self.p_low <= self.p_high <= 1
            or self.relative_confidence <= 1
            or not 0 <= self.promotion_threshold <= 1
            or self.exploration_k <= 0
        ):
            raise ValueError("invalid confidence, promotion, or exploration parameters")

    def construction(self, samples: Sequence[SolverSample]) -> ConstructionVote:
        self._parameters()
        values = _samples(samples, self.construction_samples, "construction")
        counts = sorted(
            Counter(value.answer_key for value in values).items(),
            key=lambda item: (-item[1], item[0]),
        )
        answer, first = counts[0]
        second = counts[1][1] if len(counts) > 1 else 0
        p1, p2 = first / len(values), second / len(values)
        return ConstructionVote(
            values[0].question_id,
            values[0].policy_id,
            values,
            answer,
            min(value.sample_id for value in values if value.answer_key == answer),
            p1,
            p2,
            self.p_low <= p1 <= self.p_high and p1 >= self.relative_confidence * p2,
        )

    def _vote(self, vote: ConstructionVote) -> None:
        if vote != self.construction(vote.samples):
            raise ValueError("vote differs from its complete construction evidence")

    def optimization(
        self, vote: ConstructionVote, samples: Sequence[SolverSample]
    ) -> OptimizationGroup:
        self._vote(vote)
        values = _samples(samples, self.optimization_group_size, "optimization")
        if (
            not vote.retained
            or values[0].question_id != vote.question_id
            or {value.sample_id for value in values}.intersection(
                value.sample_id for value in vote.samples
            )
        ):
            raise ValueError("optimization requires a retained question and new response samples")
        # The policy may advance during solver training. Keep each actual policy
        # identity; do not pretend construction samples are on-policy optimization.
        return OptimizationGroup(
            vote,
            values,
            tuple(1 if value.answer_key == vote.answer_key else -1 for value in values),
        )

    def exploration_probability(self, memory: Sequence[Cause], first_round_frequency: int) -> float:
        self._parameters()
        causes = _memory(memory)
        if type(first_round_frequency) is not int or first_round_frequency < 0:
            raise ValueError("round-one frequency must be a frozen nonnegative count")
        frequency = sum(cause.frequency for cause in causes.values())
        if not frequency:
            return 1.0
        if not first_round_frequency:
            raise ValueError("active causes require a nonzero round-one frequency reference")
        return first_round_frequency / (first_round_frequency + frequency / self.exploration_k)

    def schedule(
        self, memory: Sequence[Cause], *, first_round_frequency: int, count: int, rng: RandomSource
    ) -> tuple[GenerationDirective, ...]:
        epsilon = self.exploration_probability(memory, first_round_frequency)
        if type(count) is not int or count < 0:
            raise ValueError("generation count must be a nonnegative integer")
        active = sorted(
            (cause for cause in memory if cause.state == "active"), key=lambda cause: cause.cause_id
        )
        frequency = sum(cause.frequency for cause in active)

        def draw(key: str, index: int) -> float:
            value = rng.value(key, index)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 1:
                raise ValueError("random draws must be finite and within [0, 1)")
            return value

        result = []
        for index in range(count):
            if not active or draw("diagevo/mode", index) < epsilon:
                result.append(GenerationDirective("free"))
                continue
            offset = draw("diagevo/cause", index) * frequency
            for cause in active:
                offset -= cause.frequency
                if offset < 0:
                    break
            siblings = sorted(
                (
                    item
                    for item in memory
                    if item.node_id == cause.node_id and item.state == "mastered"
                ),
                key=lambda item: item.cause_id,
            )
            if siblings:
                sibling = siblings[int(draw("diagevo/sibling", index) * len(siblings))]
                result.append(GenerationDirective("stitched", (cause.cause_id, sibling.cause_id)))
            else:
                result.append(GenerationDirective("targeted", (cause.cause_id,)))
        return tuple(result)

    def update(
        self,
        memory: Sequence[Cause],
        *,
        votes: Sequence[ConstructionVote],
        generation: dict[str, GenerationDirective],
        groups: Sequence[OptimizationGroup],
        attributions: Sequence[FailureAttribution],
    ) -> tuple[Cause, ...]:
        self._parameters()
        previous = _memory(memory)
        by_question: dict[str, ConstructionVote] = {}
        sample_ids: set[str] = set()
        for vote in votes:
            self._vote(vote)
            keys = {sample.sample_id for sample in vote.samples}
            if vote.question_id in by_question or sample_ids.intersection(keys):
                raise ValueError("construction questions and sample identities must be unique")
            by_question[vote.question_id] = vote
            sample_ids.update(keys)
        if set(generation) != set(by_question) or len({vote.policy_id for vote in votes}) > 1:
            raise ValueError("promotion needs the complete round pool from one frozen solver")
        measurements: dict[str, list[float]] = {key: [] for key in previous}
        for question, directive in generation.items():
            ids = directive.cause_ids
            if directive.mode == "free" and not ids:
                continue
            if (
                directive.mode not in ("targeted", "stitched")
                or len(ids) != (1 if directive.mode == "targeted" else 2)
                or any(key not in previous for key in ids)
                or previous[ids[0]].state != "active"
                or (
                    len(ids) == 2
                    and (
                        previous[ids[1]].state != "mastered"
                        or previous[ids[0]].node_id != previous[ids[1]].node_id
                    )
                )
            ):
                raise ValueError("generation directive does not match the pre-round memory")
            # All targeted candidates count, even if confidence filtering rejects them.
            measurements[ids[0]].append(by_question[question].p1)
        failures: set[str] = set()
        for group in groups:
            if by_question.get(group.vote.question_id) != group.vote or group != self.optimization(
                group.vote, group.samples
            ):
                raise ValueError("optimization evidence differs from its construction pool")
            keys = {sample.sample_id for sample in group.samples}
            if sample_ids.intersection(keys):
                raise ValueError("optimization cannot reuse any construction or prior group sample")
            sample_ids.update(keys)
            failures.update(
                sample.sample_id
                for sample, reward in zip(group.samples, group.rewards, strict=True)
                if reward < 0
            )
        known = {key for cause in previous.values() for key in cause.failure_ids}
        seen: set[str] = set()
        additions: dict[str, Cause] = {}
        for assignment in attributions:
            if (
                assignment.sample_id not in failures
                or assignment.sample_id in seen | known
                or not all(
                    _text(value)
                    for value in (assignment.cause_id, assignment.node_id, assignment.description)
                )
                or not assignment.evidence_refs
                or not _unique(assignment.evidence_refs)
            ):
                raise ValueError("each new failed optimization trajectory may be attributed once")
            seen.add(assignment.sample_id)
            cause = previous.get(assignment.cause_id) or additions.get(assignment.cause_id)
            if cause and (cause.node_id, cause.description) != (
                assignment.node_id,
                assignment.description,
            ):
                raise ValueError("cause identity changed without explicit node consolidation")
            additions.setdefault(
                assignment.cause_id,
                Cause(
                    assignment.cause_id,
                    assignment.node_id,
                    assignment.description,
                    "active",
                    (),
                    (),
                ),
            )
        updated = {}
        for key, cause in previous.items():
            scores = measurements[key]
            promote = (
                cause.state == "active"
                and scores
                and (sum(scores) / len(scores) >= self.promotion_threshold)
            )
            updated[key] = (
                replace(cause, state="mastered", episode_failure_ids=()) if promote else cause
            )
        for key, cause in additions.items():
            old = updated.get(key, cause)
            new = tuple(sorted(item.sample_id for item in attributions if item.cause_id == key))
            updated[key] = replace(
                old,
                state="active",
                episode_failure_ids=old.episode_failure_ids + new,
                failure_ids=old.failure_ids + new,
            )
        _memory(tuple(updated.values()))
        return tuple(updated[key] for key in sorted(updated))
