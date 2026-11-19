"""Budget allocation and validated task selection, without execution or admission."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

from gear.canonical import digest
from gear.core._json import json_value
from gear.core.base import Module
from gear.core.random import RandomSource
from gear.curriculum.contracts import (
    FailureMode,
    LearningTarget,
    PracticeDraft,
    PracticeMeasurement,
    PracticeSelection,
    ProgressObservation,
    SemanticNeighborhood,
    TaskPoolPlan,
    ValidationReport,
    _mode,
    _text,
    _unique,
    _version,
)


def _budget(value: int) -> None:
    if type(value) is not int or value < 0:
        raise ValueError("budget must be a nonnegative integer")


@dataclass
class SelectLearningTargets(Module):
    strategy: Literal[
        "frequency", "uniform", "frontier", "forgetting", "rare_action", "signal_mix"
    ] = "frequency"
    max_targets: int = 8
    # Soft prioritization scores, separately ablatable. ExtractLearningSignals
    # implements the paper's boolean conditions; these are scheduling heuristics.
    frontier_weight: float = 1.0
    forgetting_weight: float = 1.0
    rare_action_weight: float = 1.0

    def __call__(
        self,
        memory: Sequence[FailureMode],
        *,
        budget: int,
        rng: RandomSource | None = None,
        progress: Sequence[ProgressObservation] = (),
        policy_id: str | None = None,
        previous_policy_id: str | None = None,
    ) -> tuple[LearningTarget, ...]:
        _budget(budget)
        if self.strategy not in (
            "frequency",
            "uniform",
            "frontier",
            "forgetting",
            "rare_action",
            "signal_mix",
        ):
            raise ValueError("unsupported target strategy")
        if type(self.max_targets) is not int or self.max_targets < 1:
            raise ValueError("max_targets must be positive")
        components = (self.frontier_weight, self.forgetting_weight, self.rare_action_weight)
        if any(
            type(weight) not in (int, float) or not math.isfinite(weight) or weight < 0
            for weight in components
        ):
            raise ValueError("signal weights must be finite and nonnegative")
        seen: set[str] = set()
        for mode in memory:
            _mode(mode)
            if mode.mode_id in seen:
                raise ValueError("duplicate memory mode")
            seen.add(mode.mode_id)
        measured = self.strategy not in ("frequency", "uniform")
        eligible = sorted(
            (
                mode
                for mode in memory
                if mode.state == "active" or (measured and mode.state == "mastered")
            ),
            key=lambda item: item.mode_id,
        )
        if not budget or not eligible:
            return ()
        if self.strategy == "uniform":
            if rng is None:
                raise ValueError("uniform selection requires an explicit random source")
            draws = [rng.value("learning-target", index) for index in range(len(eligible))]
            if any(not math.isfinite(draw) or not 0 <= draw < 1 for draw in draws):
                raise ValueError("random values must be finite and in [0, 1)")
            eligible = [
                mode
                for _, mode in sorted(
                    zip(draws, eligible), key=lambda pair: (pair[0], pair[1].mode_id)
                )
            ]
        elif self.strategy == "frequency":
            eligible.sort(key=lambda item: (-item.recurrence, item.mode_id))
        scores = self._scores(eligible, progress, policy_id, previous_policy_id) if measured else {}
        if measured:
            eligible = sorted(
                (mode for mode in eligible if scores[mode.mode_id] > 0),
                key=lambda mode: (-scores[mode.mode_id], mode.mode_id),
            )
        if not eligible:
            return ()
        eligible = eligible[: self.max_targets]
        weights = [
            Fraction(
                scores[mode.mode_id]
                if measured
                else mode.recurrence
                if self.strategy == "frequency"
                else 1
            )
            for mode in eligible
        ]
        total = sum(weights)
        shares = [budget * weight / total for weight in weights]
        counts = [share.numerator // share.denominator for share in shares]
        # Rational largest-remainder allocation preserves the exact caller budget,
        # including when weighted signal scores originated as floating points.
        order = sorted(range(len(counts)), key=lambda i: (-(shares[i] - counts[i]), i))
        for index in order[: budget - sum(counts)]:
            counts[index] += 1
        return tuple(
            LearningTarget(
                mode.mode_id, mode.description, count, mode.support_case_ids, mode.families
            )
            for mode, count in zip(eligible, counts)
            if count
        )

    def _scores(
        self,
        eligible: Sequence[FailureMode],
        progress: Sequence[ProgressObservation],
        policy_id: str | None,
        previous_policy_id: str | None,
    ) -> dict[str, float]:
        if policy_id is None:
            raise ValueError("measured selection requires an explicit current policy")
        _text(policy_id, "policy_id")
        needed = {
            "frontier": self.strategy == "frontier"
            or self.strategy == "signal_mix"
            and self.frontier_weight > 0,
            "forgetting": self.strategy == "forgetting"
            or self.strategy == "signal_mix"
            and self.forgetting_weight > 0,
            "rare_action": self.strategy == "rare_action"
            or self.strategy == "signal_mix"
            and self.rare_action_weight > 0,
        }
        if not any(needed.values()):
            raise ValueError("at least one scheduling signal must be enabled")
        if needed["forgetting"] and (previous_policy_id is None or previous_policy_id == policy_id):
            raise ValueError("forgetting requires a distinct explicit previous policy")
        observations = {}
        samples: dict[str, str] = {}
        for item in progress:
            _version(item)
            for name in ("target_id", "policy_id", "comparison_id"):
                _text(getattr(item, name), name)
            _unique(item.sample_ids, "progress sample")
            if (
                not item.sample_ids
                or not item.evidence_refs
                or type(item.successes) is not int
                or not 0 <= item.successes <= len(item.sample_ids)
            ):
                raise ValueError("progress requires observed samples, outcomes and evidence")
            _unique(item.available_actions, "available action")
            counts = dict(item.action_counts)
            if (
                len(counts) != len(item.action_counts)
                or set(counts) - set(item.available_actions)
                or any(type(count) is not int or count < 0 for count in counts.values())
            ):
                raise ValueError("action counts must bind unique declared actions")
            for sample in item.sample_ids:
                if samples.setdefault(sample, item.policy_id) != item.policy_id:
                    raise ValueError("an immutable sample cannot belong to different policies")
            key = (item.target_id, item.policy_id)
            if key in observations:
                raise ValueError("duplicate progress observation for a target and policy")
            observations[key] = item
        result = {}
        for mode in eligible:
            current = observations.get((mode.mode_id, policy_id))
            if current is None:
                raise ValueError("missing current-policy progress is unknown, not a zero score")
            frontier = 1.0 - 2.0 * abs(current.success_rate - 0.5)
            forgetting = rare_action = 0.0
            if needed["forgetting"]:
                assert previous_policy_id is not None
                previous = observations.get((mode.mode_id, previous_policy_id))
                if previous is None or previous.comparison_id != current.comparison_id:
                    raise ValueError("forgetting observations need matching evaluation conditions")
                forgetting = max(0.0, previous.success_rate - current.success_rate)
            if needed["rare_action"]:
                if not current.available_actions or set(dict(current.action_counts)) != set(
                    current.available_actions
                ):
                    raise ValueError(
                        "rare-action selection requires explicit counts for every available action"
                    )
                rare_action = sum(1.0 / (count + 1) for _, count in current.action_counts) / len(
                    current.available_actions
                )
            scores = {"frontier": frontier, "forgetting": forgetting, "rare_action": rare_action}
            result[mode.mode_id] = (
                sum(
                    scores[name]
                    * (
                        weight
                        / max(self.frontier_weight, self.forgetting_weight, self.rare_action_weight)
                    )
                    for name, weight in zip(
                        scores,
                        (self.frontier_weight, self.forgetting_weight, self.rare_action_weight),
                    )
                )
                if self.strategy == "signal_mix"
                else scores[self.strategy]
            )
        return result


@dataclass
class SelectPractice(Module):
    semantic_threshold: float | None = None
    semantic_method_id: str | None = None
    min_success_rate: float | None = None
    max_success_rate: float | None = None
    min_measurements: int = 1
    exploration_count: int = 0
    mix_counts: tuple[tuple[str, int], ...] = ()

    def __call__(
        self,
        drafts: Sequence[PracticeDraft],
        report: ValidationReport,
        *,
        budget: int,
        base_pool_version: str,
        existing_content_digests: Sequence[str] = (),
        neighborhoods: Sequence[SemanticNeighborhood] = (),
        measurements: Sequence[PracticeMeasurement] = (),
        policy_id: str | None = None,
        sources: Sequence[tuple[str, str]] = (),
        rng: RandomSource | None = None,
    ) -> TaskPoolPlan:
        _budget(budget)
        _version(report)
        _text(base_pool_version, "base_pool_version")
        results = {result.draft_id: result for result in report.results}
        if len(results) != len(report.results):
            raise ValueError("duplicate validation result")
        if len({draft.draft_id for draft in drafts}) != len(drafts):
            raise ValueError("duplicate draft_id")
        if set(results) - {draft.draft_id for draft in drafts}:
            raise ValueError("validation report contains unrelated drafts")
        lower, upper = self._parameters(budget)
        measured = lower is not None or upper is not None
        if measured and policy_id is None:
            raise ValueError("difficulty selection requires an explicit current policy")
        if self.exploration_count and (not measured or rng is None):
            raise ValueError(
                "exploration requires measured selection and an explicit random source"
            )
        known = {draft.digest: draft for draft in drafts}
        observed = self._measurements(measurements, known, policy_id)
        pool = tuple(
            sorted(set(existing_content_digests) | {draft.content_digest for draft in drafts})
        )
        nearby = self._neighborhoods(neighborhoods, known, pool)
        source_map = dict(sources)
        if len(source_map) != len(sources) or set(source_map) - set(known):
            raise ValueError("source labels must refer to unique known draft digests")
        quotas = dict(self.mix_counts)
        if quotas and (set(source_map) != set(known) or set(source_map.values()) - set(quotas)):
            raise ValueError("mixed pools require an explicit declared source for every draft")
        source_used = dict.fromkeys(quotas, 0)
        seen = set(existing_content_digests)
        selected: list[PracticeSelection] = []
        rejected: list[tuple[str, str]] = []
        regular: list[PracticeDraft] = []
        exploratory: list[PracticeDraft] = []
        for draft in sorted(drafts, key=lambda item: item.draft_id):
            item = observed.get(draft.digest)
            rate = item.successes / len(item.sample_ids) if item is not None else None
            learnable = not measured or (
                item is not None
                and len(item.sample_ids) >= self.min_measurements
                and (lower is None or rate is not None and rate >= lower)
                and (upper is None or rate is not None and rate <= upper)
            )
            (regular if learnable else exploratory).append(draft)
        if self.exploration_count:
            assert rng is not None
            draws = [rng.value("practice-exploration/" + draft.digest, 0) for draft in exploratory]
            if any(not math.isfinite(draw) or not 0 <= draw < 1 for draw in draws):
                raise ValueError("random values must be finite and in [0, 1)")
            exploratory = [
                draft
                for _, draft in sorted(
                    zip(draws, exploratory), key=lambda pair: (pair[0], pair[1].draft_id)
                )
            ]
        regular_count = exploratory_count = 0
        for draft, exploration in [
            *((draft, False) for draft in regular),
            *((draft, True) for draft in exploratory),
        ]:
            _version(draft)
            if report.policy_id != draft.plan.validation_policy_id:
                raise ValueError("validation policy changed")
            result = results.get(draft.draft_id)
            if result and result.draft_digest != draft.digest:
                raise ValueError("validation is bound to different draft bytes")
            if result and result.kind != draft.plan.kind:
                raise ValueError("validation is bound to a different practice kind")
            if result is None or not result.accepted:
                reason = "validation missing or failed"
            elif draft.content_digest in seen:
                reason = "exact duplicate"
            elif self.semantic_threshold is not None and draft.digest not in nearby:
                reason = "semantic novelty evidence missing or incomplete"
            elif self.semantic_threshold is not None and any(
                other in seen and similarity >= self.semantic_threshold
                for other, similarity in nearby[draft.digest].neighbors
            ):
                reason = "semantic near duplicate"
            elif exploration and exploratory_count >= self.exploration_count:
                reason = "outside measured difficulty range or insufficient measurements"
            elif not exploration and regular_count >= budget - self.exploration_count:
                reason = "regular selection budget exhausted"
            elif (
                quotas and source_used[source_map[draft.digest]] >= quotas[source_map[draft.digest]]
            ):
                reason = "source mix quota exhausted"
            elif len(selected) >= budget:
                reason = "budget exhausted"
            else:
                selected.append(
                    PracticeSelection(
                        draft.draft_id, draft.digest, draft.content_digest, len(selected)
                    )
                )
                seen.add(draft.content_digest)
                if exploration:
                    exploratory_count += 1
                else:
                    regular_count += 1
                if quotas:
                    source_used[source_map[draft.digest]] += 1
                continue
            rejected.append((draft.draft_id, reason))
        policy = self.describe().to_dict()
        identity = digest(
            policy
            if not (neighborhoods or measurements or sources or policy_id)
            else {
                "operator": policy,
                "policy_id": policy_id,
                "neighborhoods": json_value(tuple(neighborhoods)),
                "measurements": json_value(tuple(measurements)),
                "sources": json_value(tuple(sources)),
            }
        )
        return TaskPoolPlan(tuple(selected), tuple(rejected), base_pool_version, identity)

    def _parameters(self, budget: int) -> tuple[float | None, float | None]:
        for value in (self.semantic_threshold, self.min_success_rate, self.max_success_rate):
            if value is not None and (
                type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1
            ):
                raise ValueError("similarity and success thresholds must be in [0, 1]")
        if (
            self.min_success_rate is not None
            and self.max_success_rate is not None
            and self.min_success_rate > self.max_success_rate
        ):
            raise ValueError("difficulty range is reversed")
        if (self.semantic_threshold is None) != (self.semantic_method_id is None):
            raise ValueError("semantic threshold and method identity must be configured together")
        if self.semantic_method_id is not None:
            _text(self.semantic_method_id, "semantic_method_id")
        if type(self.min_measurements) is not int or self.min_measurements < 1:
            raise ValueError("min_measurements must be positive")
        if type(self.exploration_count) is not int or not 0 <= self.exploration_count <= budget:
            raise ValueError("exploration count must fit the explicit budget")
        quotas = dict(self.mix_counts)
        if len(quotas) != len(self.mix_counts) or any(
            type(count) is not int or count < 0 for count in quotas.values()
        ):
            raise ValueError("mix quotas must be unique nonnegative counts")
        for source in quotas:
            _text(source, "mix source")
        if quotas and sum(quotas.values()) != budget:
            raise ValueError("mix quotas must sum to the explicit budget; no silent backfill")
        return self.min_success_rate, self.max_success_rate

    def _measurements(
        self,
        measurements: Sequence[PracticeMeasurement],
        known: dict[str, PracticeDraft],
        policy_id: str | None,
    ) -> dict[str, PracticeMeasurement]:
        result = {}
        samples: dict[str, str] = {}
        for item in measurements:
            _version(item)
            _unique(item.sample_ids, "practice measurement sample")
            if item.draft_digest not in known or item.draft_digest in result:
                raise ValueError("measurement is duplicated or belongs to a different draft")
            if item.policy_id != policy_id or not item.policy_id:
                raise ValueError("difficulty measurement belongs to a different policy")
            if (
                not item.sample_ids
                or not item.evidence_refs
                or type(item.successes) is not int
                or not 0 <= item.successes <= len(item.sample_ids)
            ):
                raise ValueError("difficulty requires independently observed samples and outcomes")
            for sample in item.sample_ids:
                if samples.setdefault(sample, item.draft_digest) != item.draft_digest:
                    raise ValueError("one measured sample cannot belong to different draft bytes")
            result[item.draft_digest] = item
        return result

    def _neighborhoods(
        self,
        observations: Sequence[SemanticNeighborhood],
        known: dict[str, PracticeDraft],
        pool: tuple[str, ...],
    ) -> dict[str, SemanticNeighborhood]:
        result = {}
        seen: set[str] = set()
        for item in observations:
            _version(item)
            if item.draft_digest not in known or item.draft_digest in seen:
                raise ValueError(
                    "semantic observation is duplicated or belongs to different draft bytes"
                )
            seen.add(item.draft_digest)
            if item.method_id != self.semantic_method_id or item.comparison_pool_digest != digest(
                list(pool)
            ):
                raise ValueError("semantic observation has different method or comparison pool")
            if (
                self.semantic_threshold is None
                or type(item.minimum_similarity) not in (int, float)
                or not math.isfinite(item.minimum_similarity)
                or not 0 <= item.minimum_similarity <= self.semantic_threshold
            ):
                raise ValueError(
                    "semantic observation may omit neighbors above the configured threshold"
                )
            neighbors = dict(item.neighbors)
            if (
                len(neighbors) != len(item.neighbors)
                or set(neighbors) - set(pool)
                or any(
                    type(score) not in (int, float)
                    or not math.isfinite(score)
                    or not 0 <= score <= 1
                    for score in neighbors.values()
                )
            ):
                raise ValueError(
                    "semantic neighbors must bind unique known content with bounded scores"
                )
            if type(item.complete) is not bool:
                raise ValueError("semantic completion must be explicit")
            if item.complete and item.evidence_refs:
                result[item.draft_digest] = item
        return result
