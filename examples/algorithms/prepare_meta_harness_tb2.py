#!/usr/bin/env python3
"""Prepare the pinned Terminal-Bench 2 seed set and a separate Gear holdout."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import tomli_w

try:
    from .run_meta_harness_tb2 import REFERENCE_DATASET_COMMIT, REFERENCE_TASK_IDS
except ImportError:  # Executed directly from the examples directory.
    from run_meta_harness_tb2 import REFERENCE_DATASET_COMMIT, REFERENCE_TASK_IDS

try:
    import tomllib
except ImportError:  # Python 3.10 remains supported.
    import tomli as tomllib


def _task_directories(root: Path) -> dict[str, Path]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"task source must be a real directory: {root}")
    tasks = {
        path.name: path
        for path in root.iterdir()
        if path.is_dir() and (path / "task.toml").is_file()
    }
    if not tasks:
        raise ValueError(f"no Harbor task directories found in {root}")
    return tasks


def _reject_symlinks(directory: Path) -> None:
    if any(path.is_symlink() for path in directory.rglob("*")):
        raise ValueError(f"task source cannot contain symlinks: {directory}")


def _task_identity(directory: Path) -> tuple[str, str, frozenset[str]]:
    config = tomllib.loads((directory / "task.toml").read_text(encoding="utf-8"))
    metadata = config.get("metadata", {})
    if not isinstance(metadata, dict):
        raise TypeError(f"{directory.name}/task.toml metadata must be a table")
    family = (
        metadata.get("family")
        or metadata.get("domain")
        or metadata.get("category")
        or directory.name
    )
    if not isinstance(family, str) or not family:
        raise ValueError(f"{directory.name}/task.toml has an invalid task family")
    instruction_path = directory / "instruction.md"
    if not instruction_path.is_file():
        raise ValueError(f"{directory.name} is missing instruction.md")
    input_root = directory / "environment" / "inputs"
    input_digests = (
        frozenset(
            hashlib.sha256(path.read_bytes()).hexdigest()
            for path in input_root.rglob("*")
            if path.is_file()
        )
        if input_root.is_dir()
        else frozenset()
    )
    return (
        family,
        instruction_path.read_text(encoding="utf-8"),
        input_digests,
    )


def _copy_with_split(source: Path, destination: Path, split: str) -> tuple[str, str]:
    if source.is_symlink():
        raise ValueError(f"task directories cannot be symlinks: {source}")
    _reject_symlinks(source)
    shutil.copytree(source, destination, symlinks=True)
    task_file = destination / "task.toml"
    config: dict[str, Any] = tomllib.loads(task_file.read_text(encoding="utf-8"))
    metadata = config.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        raise TypeError(f"{source.name}/task.toml metadata must be a table")
    metadata["split"] = split
    task_file.write_text(tomli_w.dumps(config), encoding="utf-8")
    return _task_identity(destination)


def prepare_task_tree(
    seed_source: Path, heldout_source: Path, destination: Path
) -> dict[str, Any]:
    """Copy tasks into a split-labelled tree, rejecting overlap across the split."""
    output = destination.resolve()
    for source in (seed_source.resolve(), heldout_source.resolve()):
        if output == source or source in output.parents:
            raise ValueError("output directory must be outside both source directories")
    seeds = _task_directories(seed_source)
    heldout = _task_directories(heldout_source)
    actual_seed_ids = set(seeds)
    if actual_seed_ids != REFERENCE_TASK_IDS:
        raise ValueError(
            "seed task IDs do not match the pinned Terminal-Bench 2.1 manifest; "
            f"missing={sorted(REFERENCE_TASK_IDS - actual_seed_ids)}, "
            f"unexpected={sorted(actual_seed_ids - REFERENCE_TASK_IDS)}"
        )
    collisions = sorted(set(seeds) & set(heldout))
    if collisions:
        raise ValueError(f"seed and held-out task IDs overlap: {collisions}")
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"output already exists; choose a new empty path: {destination}")

    identities: dict[str, tuple[str, str, frozenset[str]]] = {}
    destination.mkdir(parents=True)
    try:
        for identifier, source in sorted(seeds.items()):
            identities[identifier] = _copy_with_split(
                source, destination / identifier, "seed"
            )
        for identifier, source in sorted(heldout.items()):
            identity = _copy_with_split(source, destination / identifier, "held_out")
            if any(
                identity[0] == seed_family
                or identity[1] == seed_instruction
                or bool(identity[2] & seed_inputs)
                for seed_family, seed_instruction, seed_inputs in identities.values()
            ):
                raise ValueError(
                    f"held-out task {identifier} shares a family, exact instruction, "
                    "or input content with a seed task"
                )
        return {
            "seed_count": len(seeds),
            "held_out_count": len(heldout),
            "seed_ids": sorted(seeds),
            "held_out_ids": sorted(heldout),
            "dataset_commit": REFERENCE_DATASET_COMMIT,
            "destination": str(destination),
        }
    except Exception:
        shutil.rmtree(destination)
        raise


def _verify_dataset_revision(repository: Path) -> None:
    result = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout.strip() != REFERENCE_DATASET_COMMIT:
        raise ValueError(
            "dataset repository must be checked out at "
            f"{REFERENCE_DATASET_COMMIT}; found {result.stdout.strip()}"
        )
    status = subprocess.run(
        ["git", "-C", str(repository), "status", "--porcelain", "--untracked-files=all"],
        check=True,
        capture_output=True,
        text=True,
    )
    if status.stdout.strip():
        raise ValueError("dataset repository must have a clean working tree")
    manifest_path = repository / "tasks" / "dataset.toml"
    manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or any(
        not isinstance(task, dict) or not isinstance(task.get("name"), str)
        for task in tasks
    ):
        raise ValueError("pinned dataset manifest has invalid task entries")
    manifest_ids = {task["name"].rsplit("/", 1)[-1] for task in tasks}
    if manifest_ids != REFERENCE_TASK_IDS or len(tasks) != len(REFERENCE_TASK_IDS):
        raise ValueError("pinned dataset manifest task IDs do not match the 89 reference tasks")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-repo", type=Path, required=True)
    parser.add_argument(
        "--heldout-source",
        type=Path,
        required=True,
        help="independent Harbor task directory; no IDs/families/instructions from seed",
    )
    parser.add_argument("--output", type=Path, required=True, help="new output task directory")
    args = parser.parse_args()
    try:
        _verify_dataset_revision(args.dataset_repo)
        result = prepare_task_tree(
            args.dataset_repo / "tasks", args.heldout_source, args.output
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
