"""Reflect on scored execution and curate reusable playbook entries."""

from dataclasses import asdict
from typing import Any

from gear.algorithms.opro import OPRO
from gear.core import Meta
from gear.memory import MergePlaybook, PlaybookDelta, PlaybookEntry, PlaybookInput


class ACE(OPRO):
    """Apply explicit playbook deltas, evaluate them, and retain improving updates."""

    def __init__(
        self,
        prompt_path: str = "AGENTS.md",
        proposer: Any = None,
        merger: Any = None,
        reader: Any = None,
        editor: Any = None,
        evaluator: Any = None,
        ranker: Any = None,
    ) -> None:
        reflector = (
            proposer
            if proposer is not None
            else Meta(
                "Reflect on the scored executions and curate a reusable playbook. "
                "Return a small explicit delta: add new instructions, replace existing IDs, "
                "or remove harmful existing IDs. Preserve useful entries; never put task IDs "
                "or expected answers in instructions. Existing entries and history are supplied.",
                {
                    "type": "object",
                    "properties": {
                        "add": {"type": "array", "items": {"type": "string"}},
                        "replace": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string"},
                                    "text": {"type": "string"},
                                },
                                "required": ["id", "text"],
                                "additionalProperties": False,
                            },
                        },
                        "remove": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["add", "replace", "remove"],
                    "additionalProperties": False,
                },
            )
        )
        super().__init__(prompt_path, reflector, reader, editor, evaluator, ranker)
        self.merger = merger if merger is not None else MergePlaybook()

    def _proposal(self, value: dict[str, Any], data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        existing = tuple(PlaybookEntry(**item) for item in data.get("playbook", []))
        known = {item.id for item in existing}
        additions = {
            entry.id: entry
            for entry in map(PlaybookEntry.create, value["add"])
            if entry.id not in known
        }
        delta = PlaybookDelta(
            tuple(additions.values()),
            tuple(PlaybookEntry(**item) for item in value["replace"]),
            tuple(value["remove"]),
        )
        entries = self.merger(PlaybookInput(existing, delta))
        instructions = "\n".join("- " + entry.text for entry in entries)
        text = data["base_prompt"].rstrip() + "\n\n## Learned playbook\n" + instructions + "\n"
        return text, {"proposed_playbook": [asdict(entry) for entry in entries]}
