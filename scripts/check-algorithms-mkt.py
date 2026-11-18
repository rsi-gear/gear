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

import yaml
from gear import Project, ProjectError, Run
from gear.algorithms import ACE, GEPA, OPRO, RRSI, DarwinX, Harness2, RandomSearch
from gear.benchmark import compile_benchmark
from gear.benchmark.payload import content_bytes
from gear.core import AccessPolicy

ALGORITHMS = {
    cls.__name__: cls
    for cls in (OPRO, ACE, RRSI, DarwinX, GEPA, RandomSearch, Harness2)
}


def compile_project_benchmark(root: Path) -> dict:
    project = yaml.safe_load((root / "gear.yaml").read_text())
    config = yaml.safe_load((root / project["benchmark"]).read_text())
    return compile_benchmark(root, config)


def check_dataset(
    benchmark: dict, selection: dict, expected_digest: str | None = None
) -> str:
    """Bind the selected source to the imported dataset and the frozen run."""
    tasks = set(selection["selection"]["task_ids"])
    assert set(benchmark["splits"]["seed"]) == tasks, "Selected seed tasks changed"
    assert {task["id"] for task in benchmark["tasks"]} == tasks, (
        "Dataset task set changed"
    )
    manifest = benchmark["adapter_manifest"]
    source = manifest
    if manifest["dataset_digest"] != selection["dataset_digest"]:
        originals = [
            file
            for file in benchmark["native_root_files"]
            if file["path"] == "source-benchmark.adapter.json"
        ]
        assert len(originals) == 1, "Imported dataset is missing its source manifest"
        source = json.loads(content_bytes(originals[0], benchmark["native_blobs"]))
    assert source["dataset_digest"] == selection["dataset_digest"], (
        "Selected source dataset changed"
    )
    assert {task["task_id"] for task in source["tasks"]} == tasks, (
        "Source task set changed"
    )
    for key in ("benchmark", "adapter", "scoring", "raw_metrics"):
        assert source.get(key) == manifest.get(key), (
            f"Import changed the {key} contract"
        )
    if expected_digest is not None:
        assert manifest["dataset_digest"] == expected_digest, "Prepared dataset changed"
    return manifest["dataset_digest"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--algorithm", choices=ALGORITHMS, action="append")
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Check an existing run through the read-only report API; never execute or resume it",
    )
    args = parser.parse_args()
    selection = json.loads(args.selection.read_text())
    tasks = tuple(selection["selection"]["task_ids"])
    assert len(tasks) == len(set(tasks)) == 10
    assert all(task.startswith("marketing-") for task in tasks)
    expected_dataset_digest = check_dataset(
        compile_project_benchmark(args.template), selection
    )
    args.output.mkdir(parents=True, exist_ok=True)
    result_file = args.output / "results.json"
    results = json.loads(result_file.read_text()) if result_file.exists() else {}
    selected = args.algorithm or list(ALGORITHMS)
    for name in selected:
        root = args.output / name
        if not root.exists():
            if args.verify_only:
                raise ValueError(f"No existing {name} project to verify")
            shutil.copytree(args.template, root, ignore=shutil.ignore_patterns(".gear"))
        project = Project.open(root)
        print(json.dumps({"algorithm": name, "status": "starting"}), flush=True)
        try:
            check_dataset(
                compile_project_benchmark(root), selection, expected_dataset_digest
            )
            runs = sorted(
                (root / ".gear/runs").glob("*/journal.json"),
                key=lambda p: p.stat().st_mtime,
            )
            if args.verify_only:
                if not runs:
                    raise ValueError(f"No existing {name} run to verify")
                run_id = runs[-1].parent.name
                run = Run(run_id, project.report(run_id))
            elif runs:
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
            check_dataset(benchmark, selection, expected_dataset_digest)
            if name in ("GEPA", "RandomSearch"):
                iterations = journal["state"]["data"]["round"]
                assert iterations == 2, f"Only {iterations} search rounds completed"
                assert all(op["status"] == "complete" for op in journal["operations"])
            else:
                operators = journal["operators"]
                assert all(
                    call.get("result", {}).get("status") == "succeeded"
                    for call in operators["calls"]
                ), "An operator call did not succeed"
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
            assert all(op["status"] == "complete" for op in journal["operations"]), (
                "Incomplete operation"
            )
            recovered = set(report.get("recovered_operation_ids", []))
            assert all(
                op["receipt"]["result"]["status"] == "complete"
                or op["request"]["operationId"] in recovered
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
            generation_usage = {"model_requests": 0, "tokens": 0}
            for operation in meta_calls:
                receipt = operation["receipt"]
                assert receipt["provenance"]["provider"] == "hitch", (
                    "Meta did not use Hitch"
                )
                assert receipt["provenance"]["harness"] == "codex", (
                    "Meta did not use Codex"
                )
                for dimension in generation_usage:
                    actual = receipt["usage"][dimension]
                    allowance = operation["request"]["generationLimits"][dimension]
                    assert actual is not None and 0 < actual <= allowance, (
                        f"Invalid {dimension} usage"
                    )
                    generation_usage[dimension] += actual
            for dimension, actual in generation_usage.items():
                assert (
                    actual <= report["generation_budget"]["policy"]["total"][dimension]
                ), f"Exceeded total {dimension} budget"
            results[name] = {
                "status": "passed",
                "run_id": run.id,
                "iterations": iterations,
                "generation_usage": generation_usage,
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
    if any(results[name]["status"] != "passed" for name in selected):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
