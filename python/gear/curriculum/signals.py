"""CoEvolve-style behavioral signals from explicitly comparable rollout facts.

Follows the three boolean conditions in arXiv:2604.15840v1 section 3.1.
Signal extraction is independent of task generation, environment exploration and
training. It neither infers missing rewards nor invents unobserved rare actions.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict, deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from gear.canonical import JSON
from gear.core.base import Module
from gear.curriculum.cases import _cases
from gear.curriculum.contracts import OutcomeCase, _text, _unique, _version


@dataclass(frozen=True)
class BehavioralObservation:
    """Input order is chronological; group_id identifies one fixed-policy rollout group."""

    case: OutcomeCase
    comparison_id: str
    group_id: str
    score: float | None
    action_patterns: tuple[str, ...] = ()
    schema_version: int = 1


@dataclass(frozen=True)
class LearningSignals:
    case_id: str
    signals: tuple[Literal["forgetting", "boundary", "rare"], ...]
    rare_patterns: tuple[str, ...]
    evidence_refs: tuple[JSON, ...]
    schema_version: int = 1


@dataclass
class ExtractLearningSignals(Module):
    history_window: int = 5
    boundary_threshold: float = 0.5
    rare_frequency: float = 0.05
    minimum_patterns: int = 20

    def __call__(
        self, observations: Sequence[BehavioralObservation], *, policy_id: str
    ) -> tuple[LearningSignals, ...]:
        _text(policy_id, "policy_id")
        if type(self.history_window) is not int or self.history_window < 1:
            raise ValueError("history_window must be positive")
        if type(self.minimum_patterns) is not int or self.minimum_patterns < 1:
            raise ValueError("minimum_patterns must be positive")
        for number in (self.boundary_threshold, self.rare_frequency):
            if type(number) not in (int, float) or not math.isfinite(number) or not 0 < number < 1:
                raise ValueError("signal thresholds must lie strictly inside (0, 1)")
        _cases(tuple(item.case for item in observations))
        samples: dict[str, tuple[str, str, str]] = {}
        groups: dict[tuple[str, ...], list[BehavioralObservation]] = defaultdict(list)
        history: dict[tuple[str, ...], deque[float]] = {}
        counts: dict[str, Counter[str]] = defaultdict(Counter)
        flagged: dict[str, list[Literal["forgetting", "boundary", "rare"]]] = {}
        complete: list[BehavioralObservation] = []
        for item in observations:
            _version(item)
            _text(item.comparison_id, "comparison_id")
            _text(item.group_id, "group_id")
            _unique(item.action_patterns, "action pattern")
            record = item.case.record
            identity = (record.policy_id, record.task_id, record.environment_id)
            if samples.setdefault(record.sample_id, identity) != identity:
                raise ValueError(
                    "one immutable sample cannot be reused under another execution identity"
                )
            if item.score is not None and (
                type(item.score) not in (int, float)
                or not math.isfinite(item.score)
                or not 0 <= item.score <= 1
            ):
                raise ValueError("scores must be normalized finite observations or unknown")
            if item.case.outcome not in ("success", "failure") or item.score is None:
                continue
            if not record.evidence_refs:
                raise ValueError("behavioral signals require referenced execution evidence")
            scope = (record.task_id, record.environment_id, item.comparison_id)
            recent = history.setdefault(scope, deque(maxlen=self.history_window))
            # The paper's recent window includes the current observation. A
            # failing current score cannot itself satisfy the prior-success test.
            recent.append(item.score)
            signals: list[Literal["forgetting", "boundary", "rare"]] = []
            if (
                record.policy_id == policy_id
                and item.score < self.boundary_threshold
                and any(score >= self.boundary_threshold for score in recent)
            ):
                signals.append("forgetting")
            flagged[item.case.case_id] = signals
            group_key = scope + (record.policy_id, item.group_id)
            groups[group_key].append(item)
            # Names are scoped to one environment, avoiding accidental action
            # collisions between unrelated tool systems.
            counts[record.environment_id].update(item.action_patterns)
            complete.append(item)
        for group in groups.values():
            if group[0].case.record.policy_id != policy_id:
                continue
            if any(
                item.score is not None and item.score > self.boundary_threshold for item in group
            ) and any(
                item.score is not None and item.score < self.boundary_threshold for item in group
            ):
                for item in group:
                    flagged[item.case.case_id].append("boundary")
        result = []
        for item in complete:
            if item.case.record.policy_id != policy_id:
                continue
            occurrences = counts[item.case.record.environment_id]
            total = sum(occurrences.values())
            rare = tuple(
                sorted(
                    pattern
                    for pattern in item.action_patterns
                    if total >= self.minimum_patterns
                    and 0 < occurrences[pattern] / total < self.rare_frequency
                )
            )
            signals = flagged[item.case.case_id]
            if rare:
                signals.append("rare")
            if signals:
                result.append(
                    LearningSignals(
                        item.case.case_id, tuple(signals), rare, item.case.record.evidence_refs
                    )
                )
        return tuple(result)
