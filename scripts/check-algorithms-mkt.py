"""Run built-in algorithms for two rounds on an explicitly prepared 10-task MKT project.

The template must use real Codex Meta and Hitch/DSH Target profiles. Credentials and
profile locations are supplied by the caller, never embedded in this script.
Each algorithm gets its own project; existing runs resume from their frozen state.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from gear import Project, ProjectError
from gear.algorithms import ACE, GEPA, OPRO, RRSI, DarwinX, Harness2, RandomSearch
from gear.core import AccessPolicy

ALGORITHMS = {
    cls.__name__: cls
    for cls in (OPRO, ACE, RRSI, DarwinX, GEPA, RandomSearch, Harness2)
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--algorithm", choices=ALGORITHMS, action="append")
    args = parser.parse_args()
    selection = json.loads(args.selection.read_text())
    tasks = tuple(selection["selection"]["task_ids"])
    assert len(tasks) == len(set(tasks)) == 10
    assert all(task.startswith("marketing-") for task in tasks)
    args.output.mkdir(parents=True, exist_ok=True)
    result_file = args.output / "results.json"
    results = json.loads(result_file.read_text()) if result_file.exists() else {}
    for name in args.algorithm or ALGORITHMS:
        root = args.output / name
        if not root.exists():
            shutil.copytree(args.template, root, ignore=shutil.ignore_patterns(".gear"))
        project = Project.open(root)
        print(json.dumps({"algorithm": name, "status": "starting"}), flush=True)
        try:
            runs = sorted(
                (root / ".gear/runs").glob("*/journal.json"),
                key=lambda p: p.stat().st_mtime,
            )
            if runs:
                run = project.resume(runs[-1].parent.name)
            else:
                algorithm = (
                    ALGORITHMS[name]()
                    if name in ("GEPA", "RandomSearch")
                    else ALGORITHMS[name](prompt_path="prompts/system.md")
                )
                access = (
                    AccessPolicy(
                        exposure="blind",
                        rollout_backend="scored_private",
                        task_order=tasks,
                    )
                    if name == "Harness2"
                    else None
                )
                run = project.refine(algorithm=algorithm, rounds=2, access=access)
            report = run.report.summary
            journal = json.loads(
                (root / ".gear/runs" / run.id / "journal.json").read_text()
            )
            assert report["status"] == "completed", report["status"]
            assert {task["id"] for task in journal["spec"]["seedTasks"]} == set(tasks)
            assert journal["spec"]["budget"]["rounds"] == 2
            benchmark = json.loads(
                (root / ".gear/runs" / run.id / "benchmark.json").read_text()
            )
            assert (
                benchmark["adapter_manifest"]["dataset_digest"]
                == selection["dataset_digest"]
            )
            if name in ("GEPA", "RandomSearch"):
                iterations = journal["state"]["data"]["round"]
                assert iterations == 2, f"Only {iterations} search rounds completed"
                assert all(op["status"] == "complete" for op in journal["operations"])
            else:
                operators = journal["operators"]
                assert all(
                    call.get("result", {}).get("status") == "succeeded"
                    for call in operators["calls"]
                )
                iterations = operators["state"]["data"].get(
                    "iterations" if name == "Harness2" else "round"
                )
                assert iterations == (20 if name == "Harness2" else 2), (
                    f"Only {iterations} iterations completed"
                )
                if name == "Harness2":
                    assert (
                        tuple(
                            item["task_id"] for item in operators["stream"]["completed"]
                        )
                        == tasks
                    )
                    outputs = [
                        artifact["value"]
                        for artifact in operators["artifacts"]
                        if artifact["ref"]["kind"] == "task_output"
                    ]
                    assert len(outputs) == 20
                    assert all(output["status"] == "succeeded" for output in outputs)
            assert journal["physicalAttempts"] > 0, "No real target executions"
            if name != "Harness2":
                assert report["coverage"]["invalid"] == 0, "Invalid target observations"
            assert all(op["status"] == "complete" for op in journal["operations"])
            assert all(
                op["receipt"]["result"]["status"] == "complete"
                for op in journal["operations"]
            ), "A completed operation contains a failed provider receipt"
            assert all(
                cell["score"] is not None and cell["status"] in ("valid", "task_failed")
                for op in journal["operations"]
                for cell in op["receipt"]["evidence"]
            ), "Invalid physical observation"
            meta_calls = [
                op
                for op in journal["operations"]
                if op["request"]["operation"]["kind"]
                in ("diagnose_seed", "generate_candidate")
            ]
            assert len(meta_calls) >= (20 if name == "Harness2" else 2), (
                "Missing real Meta calls"
            )
            results[name] = {
                "status": "passed",
                "run_id": run.id,
                "iterations": iterations,
                "report": report,
            }
        except (ProjectError, AssertionError, ValueError, KeyError, OSError) as error:
            stderr = getattr(error, "stderr", None)
            if stderr:
                diagnostic = root / "runtime-error.log"
                diagnostic.touch(mode=0o600, exist_ok=True)
                diagnostic.write_bytes(stderr)
            results[name] = {
                "status": "failed",
                "type": type(error).__name__,
                "message": str(error),
            }
        (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "algorithm": name,
                    **{k: v for k, v in results[name].items() if k != "report"},
                }
            ),
            flush=True,
        )
    if any(result["status"] != "passed" for result in results.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
