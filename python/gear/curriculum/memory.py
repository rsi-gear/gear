"""Explicit, immutable failure memory updates."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from gear.core.base import Module
from gear.curriculum.contracts import FailureMode, MasteryObservation, _mode, _text, _version


class MergeFailureMemory(Module):
    def __call__(
        self,
        memory: Sequence[FailureMode],
        delta: Sequence[FailureMode],
        *,
        measurements: Sequence[MasteryObservation] = (),
    ) -> tuple[FailureMode, ...]:
        modes: dict[str, FailureMode] = {}
        for value in memory:
            _mode(value)
            if value.mode_id in modes:
                raise ValueError("duplicate memory mode")
            modes[value.mode_id] = value
        seen: set[str] = set()
        for value in delta:
            _mode(value)
            if value.mode_id in seen:
                raise ValueError("duplicate diagnosis mode")
            seen.add(value.mode_id)
            if value.state != "active" or value.mastery is not None:
                raise ValueError("diagnosis cannot assert measured mastery")
            previous = modes.get(value.mode_id)
            if previous is None:
                modes[value.mode_id] = value
                continue
            if (value.description, value.diagnoser_id) != (
                previous.description,
                previous.diagnoser_id,
            ):
                raise ValueError("mode identity changed; use an explicit new mode_id")
            new_failures = set(value.support_case_ids) - set(previous.support_case_ids)
            merged = replace(
                previous,
                support_case_ids=tuple(
                    sorted(set(previous.support_case_ids + value.support_case_ids))
                ),
                counterexample_case_ids=tuple(
                    sorted(set(previous.counterexample_case_ids + value.counterexample_case_ids))
                ),
                families=tuple(sorted(set(previous.families + value.families))),
                state="active" if new_failures else previous.state,
                mastery=None if new_failures else previous.mastery,
            )
            _mode(merged)
            modes[value.mode_id] = merged
        measured: set[str] = set()
        for observation in measurements:
            _version(observation)
            _text(observation.policy_id, "mastery policy_id")
            if observation.mode_id not in modes or observation.mode_id in measured:
                raise ValueError("unknown or duplicate mastery mode")
            if type(observation.mastered) is not bool or not observation.evidence_refs:
                raise ValueError("mastery requires an explicit measurement and evidence")
            measured.add(observation.mode_id)
            modes[observation.mode_id] = replace(
                modes[observation.mode_id],
                state="mastered" if observation.mastered else "active",
                mastery=observation,
            )
        return tuple(modes[key] for key in sorted(modes))
