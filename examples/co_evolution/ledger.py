"""Joint ledger linking model checkpoints, harness versions, data, and evals."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class JointLedger:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("", encoding="utf-8")

    def append(self, row: dict[str, Any]) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    def rows(self) -> list[dict[str, Any]]:
        text = self.path.read_text(encoding="utf-8").strip()
        if not text:
            return []
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def summary_table(self) -> list[dict[str, Any]]:
        table: list[dict[str, Any]] = []
        for row in self.rows():
            table.append(
                {
                    "round": row["round"],
                    "setting": row["setting"],
                    "modelId": row["modelId"],
                    "harnessId": row["harnessId"],
                    "trainDigest": row.get("trainDigest"),
                    "seedDigest": row.get("seedDigest"),
                    "heldOutReward": row["heldOut"]["meanReward"],
                    "heldOutInteraction": row["heldOut"]["meanInteraction"],
                    "budgetSpent": row["budget"]["spent"],
                    "budgetRemaining": row["budget"]["remaining"],
                    "modelUpdated": row["updates"]["model"],
                    "harnessUpdated": row["updates"]["harness"],
                }
            )
        return table

    def write_summary(self, destination: Path) -> Path:
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "ledgerPath": str(self.path),
            "rows": self.summary_table(),
            "final": self.summary_table()[-1] if self.summary_table() else None,
        }
        destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return destination
