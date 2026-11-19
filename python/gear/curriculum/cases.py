"""Extract logical samples from caller-normalized execution attempts."""

from __future__ import annotations

from collections.abc import Sequence

from gear.core.base import Module
from gear.curriculum.contracts import Outcome, OutcomeCase, OutcomeRecord, _text, _version


class ExtractOutcomeCases(Module):
    """Keep the latest attempt per sample; ignore validation/test material.

    Conflicting identities or duplicate attempts are rejected rather than
    silently counted. Partial executions and unavailable verdicts stay unknown.
    """

    def __call__(self, records: Sequence[OutcomeRecord]) -> tuple[OutcomeCase, ...]:
        attempts: dict[tuple[str, int], OutcomeRecord] = {}
        identities: dict[str, tuple[str, ...]] = {}
        latest: dict[str, OutcomeRecord] = {}
        for record in records:
            _version(record)
            for name in ("task_id", "family", "sample_id", "policy_id", "environment_id"):
                _text(getattr(record, name), name)
            if type(record.attempt) is not int or record.attempt < 0:
                raise ValueError("attempt must be a nonnegative integer")
            if type(record.complete) is not bool or (
                record.passed is not None and type(record.passed) is not bool
            ):
                raise ValueError("complete and passed require explicit boolean verdicts")
            if record.status not in ("completed", "infrastructure_error", "unknown"):
                raise ValueError("unknown execution status")
            if record.partition not in ("train", "validation", "test"):
                raise ValueError("unknown partition")
            identity = (
                record.task_id,
                record.family,
                record.policy_id,
                record.environment_id,
                record.partition,
            )
            if identities.setdefault(record.sample_id, identity) != identity:
                raise ValueError("sample_id reused with a different identity")
            key = (record.sample_id, record.attempt)
            if key in attempts and attempts[key] != record:
                raise ValueError("conflicting evidence for the same sample attempt")
            attempts[key] = record
            if record.sample_id not in latest or record.attempt > latest[record.sample_id].attempt:
                latest[record.sample_id] = record
        result = []
        for _, record in sorted(latest.items()):
            if record.partition != "train":
                continue
            outcome: Outcome = "unknown"
            if record.status == "infrastructure_error":
                outcome = "infrastructure_error"
            elif record.status == "completed" and record.complete and record.passed is not None:
                outcome = "success" if record.passed else "failure"
            result.append(OutcomeCase(record, outcome))
        return tuple(result)


def _cases(values: Sequence[OutcomeCase]) -> dict[str, OutcomeCase]:
    result: dict[str, OutcomeCase] = {}
    for value in values:
        _version(value)
        canonical = ExtractOutcomeCases()((value.record,))
        if not canonical or canonical[0] != value:
            raise ValueError("case must match its complete, permitted execution evidence")
        if value.case_id in result:
            raise ValueError("duplicate case identity")
        result[value.case_id] = value
    return result
