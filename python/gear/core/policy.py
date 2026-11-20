"""Basic callable components and operations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from gear.canonical import JSON, digest
from gear.core._json import json_object
from gear.core.base import describe_module
from gear.core.calls import ArtifactRef, CandidateRef, checked_name


@dataclass(frozen=True)
class ScreeningPolicy:
    """Require these frozen components; each must also belong to the algorithm tree."""

    critic: Any
    edit_check: Any
    predicate: Any

    def to_dict(self) -> dict[str, JSON]:
        result: dict[str, JSON] = {}
        for name in ("critic", "edit_check", "predicate"):
            spec = describe_module(getattr(self, name)).to_dict()
            result[name] = {"entrypoint": spec["entrypoint"], "configuration_digest": digest(spec)}
        return result


@dataclass(frozen=True)
class AccessPolicy:
    """Freeze feedback visibility and an optional finite task order at admission.

    Blind feedback remains hidden across tasks. ``scored_private`` explicitly
    permits the backend to run its verifier, while keeping its results private.
    """

    exposure: Literal["scored", "blind"] = "scored"
    rollout_backend: Literal["scored_private"] | None = None
    task_order: tuple[str, ...] | None = None
    usage_metrics: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, JSON]:
        if self.exposure not in ("scored", "blind") or (
            self.rollout_backend != ("scored_private" if self.exposure == "blind" else None)
        ):
            raise ValueError("blind access requires explicit scored_private permission")
        if self.task_order is not None:
            if not self.task_order or len(set(self.task_order)) != len(self.task_order):
                raise ValueError("task order must be finite, nonempty and unique")
            for task in self.task_order:
                checked_name(task)
        for metric in self.usage_metrics:
            checked_name(metric)
        return {
            "exposure": self.exposure,
            "rollout_backend": self.rollout_backend,
            "task_order": list(self.task_order) if self.task_order is not None else None,
            "usage_metrics": list(self.usage_metrics),
        }


@dataclass(frozen=True)
class ImportSource:
    """Explicitly admit frozen material or comparable evidence from this project.

    Candidate material is copied into ``view.candidate('import_' + name)``;
    artifacts retain their immutable reference and are available to ReadArtifact.
    Evidence import grants no ability to run an old sample again.
    """

    name: str
    ref: CandidateRef | ArtifactRef
    purpose: Literal["material", "evidence"] = "material"

    def to_dict(self) -> dict[str, JSON]:
        checked_name(self.name)
        if self.purpose not in ("material", "evidence"):
            raise ValueError("source import purpose must be material or evidence")
        return {"name": self.name, "ref": json_object(self.ref), "purpose": self.purpose}
