"""Iterative prompt proposals screened before benchmark execution."""

from typing import Any

from gear.algorithms.opro import OPRO
from gear.core import CheckEdits, Meta
from gear.search import ScreenedEvaluate


class RRSI(OPRO):
    """Compose a proposer, exact-edit check, critic, evaluator and score comparison."""

    def __init__(
        self,
        prompt_path: str = "AGENTS.md",
        proposer: Any = None,
        screen: Any = None,
        reader: Any = None,
        editor: Any = None,
        evaluator: Any = None,
        ranker: Any = None,
    ) -> None:
        super().__init__(prompt_path, proposer, reader, editor, evaluator, ranker)
        self.screen = (
            screen
            if screen is not None
            else ScreenedEvaluate(
                critic=Meta(
                    "Review the sealed candidate and exact edit before evaluation. "
                    "Check preserved tool and output contracts, generality and executable instructions. "
                    "Return allow, reject, or insufficient_evidence, with a concise reason.",
                    {
                        "type": "object",
                        "properties": {
                            "status": {"enum": ["allow", "reject", "insufficient_evidence"]},
                            "reason": {"type": "string"},
                        },
                        "required": ["status", "reason"],
                        "additionalProperties": False,
                    },
                ),
                edit_check=CheckEdits(
                    allowed_paths=(self.prompt_path,), max_files=1, max_changed_bytes=65536
                ),
                evaluator=self.evaluator,
            )
        )
