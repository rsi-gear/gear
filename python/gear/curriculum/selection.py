"""Budget allocation and validated task selection, without execution or admission."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from gear.canonical import digest
from gear.core.base import Module
from gear.core.random import RandomSource
from gear.curriculum.contracts import (
    FailureMode,
    LearningTarget,
    PracticeDraft,
    PracticeSelection,
    TaskPoolPlan,
    ValidationReport,
    _mode,
    _text,
    _version,
)


def _budget(value: int) -> None:
    if type(value) is not int or value < 0:
        raise ValueError("budget must be a nonnegative integer")


@dataclass
class SelectLearningTargets(Module):
    strategy: Literal["frequency", "uniform"] = "frequency"
    max_targets: int = 8

    def __call__(
        self, memory: Sequence[FailureMode], *, budget: int, rng: RandomSource | None = None
    ) -> tuple[LearningTarget, ...]:
        _budget(budget)
        if self.strategy not in ("frequency", "uniform"):
            raise ValueError("unsupported target strategy")
        if type(self.max_targets) is not int or self.max_targets < 1:
            raise ValueError("max_targets must be positive")
        seen: set[str] = set()
        for mode in memory:
            _mode(mode)
            if mode.mode_id in seen:
                raise ValueError("duplicate memory mode")
            seen.add(mode.mode_id)
        eligible = sorted(
            (mode for mode in memory if mode.state == "active"), key=lambda item: item.mode_id
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
        else:
            eligible.sort(key=lambda item: (-item.recurrence, item.mode_id))
        eligible = eligible[: self.max_targets]
        weights = [mode.recurrence if self.strategy == "frequency" else 1 for mode in eligible]
        total = sum(weights)
        counts = [budget * weight // total for weight in weights]
        # Integer largest-remainder allocation preserves the exact caller budget.
        order = sorted(range(len(counts)), key=lambda i: (-(budget * weights[i] % total), i))
        for index in order[: budget - sum(counts)]:
            counts[index] += 1
        return tuple(
            LearningTarget(
                mode.mode_id, mode.description, count, mode.support_case_ids, mode.families
            )
            for mode, count in zip(eligible, counts)
            if count
        )


class SelectPractice(Module):
    def __call__(
        self,
        drafts: Sequence[PracticeDraft],
        report: ValidationReport,
        *,
        budget: int,
        base_pool_version: str,
        existing_content_digests: Sequence[str] = (),
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
        seen = set(existing_content_digests)
        selected: list[PracticeSelection] = []
        rejected: list[tuple[str, str]] = []
        for draft in sorted(drafts, key=lambda item: item.draft_id):
            _version(draft)
            if report.policy_id != draft.plan.validation_policy_id:
                raise ValueError("validation policy changed")
            result = results.get(draft.draft_id)
            if result and result.draft_digest != draft.digest:
                raise ValueError("validation is bound to different draft bytes")
            if result is None or not result.accepted:
                reason = "validation missing or failed"
            elif draft.content_digest in seen:
                reason = "exact duplicate"
            elif len(selected) >= budget:
                reason = "budget exhausted"
            else:
                selected.append(
                    PracticeSelection(
                        draft.draft_id, draft.digest, draft.content_digest, len(selected)
                    )
                )
                seen.add(draft.content_digest)
                continue
            rejected.append((draft.draft_id, reason))
        return TaskPoolPlan(
            tuple(selected), tuple(rejected), base_pool_version, digest(self.describe().to_dict())
        )
