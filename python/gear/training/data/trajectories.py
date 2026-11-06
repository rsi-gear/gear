"""Sealed trajectory evidence, independent of recipe and command-line execution."""

from dataclasses import asdict, dataclass
from pathlib import Path

from gear.training.storage.content import atomic_json, digest_json


@dataclass(frozen=True)
class RawTrajectory:
    episode_ref: dict
    feedback_ref: dict
    receipt_refs: list
    context_ref: dict
    assembly_ref: dict | None = None

    def refs(self):
        return [
            self.episode_ref,
            self.feedback_ref,
            *self.receipt_refs,
            self.context_ref,
            *([self.assembly_ref] if self.assembly_ref else []),
        ]


def persist_trajectory(store, directory, episode, feedback, receipt_refs, context, assembly=None):
    raw = RawTrajectory(
        store.put_json(episode),
        store.put_json(feedback),
        receipt_refs,
        store.put_json(context),
        store.put_json(assembly) if assembly is not None else None,
    )
    ref = store.put_json({"schemaVersion": 1, "kind": "raw-trajectory", **asdict(raw)})
    atomic_json(
        Path(directory) / "trajectories" / (digest_json(episode["id"])[7:] + ".json"),
        {"trajectoryRef": ref},
    )
    return raw, ref
