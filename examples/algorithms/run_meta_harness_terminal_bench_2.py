"""Run the pinned one-iteration Meta-Harness TB2 configuration in a prepared Gear project."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from gear import Project
from gear.algorithms import MetaHarness


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path, help="prepared Gear project with the pinned TB2 tasks")
    args = parser.parse_args()

    config_path = Path(__file__).with_name("meta-harness-terminal-bench-2.json")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    run = Project.open(args.project).refine(
        algorithm=MetaHarness(), rounds=config["budgets"]["search_iterations"]
    )
    print(
        json.dumps(
            {
                "run_id": run.id,
                "reference_commit": config["reference"]["commit"],
                "dataset_revision": config["dataset"]["manifest_revision"],
                "result": run.report.summary,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
