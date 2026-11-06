"""Validate and derive versioned native benchmark manifests while preserving source bytes."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from pathlib import Path

from .compiler import bytes_digest, contained_file
from .environment import read_text
from .payload import Payload, content_bytes
from .source import BenchmarkError, json_value

ROOT_FILES = ("benchmark.adapter.json", "source-manifest.json", "source-benchmark.adapter.json")


def object_fields(value, allowed, required, location):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise BenchmarkError("invalid or unsupported manifest fields", location)


def identifier(value, location):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value):
        raise BenchmarkError("invalid manifest identifier", location)


def validate_manifest(manifest: dict):
    object_fields(
        manifest,
        {
            "schema_version",
            "kind",
            "benchmark",
            "adapter",
            "scoring",
            "raw_metrics",
            "tasks",
            "dataset_digest",
        },
        {"schema_version", "kind", "benchmark", "adapter", "scoring", "tasks", "dataset_digest"},
        "benchmark.adapter.json",
    )
    if manifest["schema_version"] != "1" or manifest["kind"] != "gear-harbor-benchmark":
        raise BenchmarkError(
            "unsupported native benchmark manifest version", "benchmark.adapter.json"
        )
    for key in ("benchmark", "adapter"):
        fields = {"id", "revision"} | ({"output_protocol"} if key == "adapter" else set())
        item = manifest[key]
        object_fields(item, fields, fields, key)
        identifier(item["id"], key)
        if (
            not isinstance(item["revision"], str)
            or not 0 < len(item["revision"]) <= 512
            or item["revision"].lower() == "latest"
        ):
            raise BenchmarkError("manifest revision must be immutable", key)
    if manifest["adapter"]["output_protocol"] != "gear-harbor-eval-result-v1":
        raise BenchmarkError("unsupported native score protocol", "adapter.output_protocol")
    object_fields(manifest["scoring"], {"total_score", "process_score"}, {"total_score"}, "scoring")
    for name, score in manifest["scoring"].items():
        fields = {"source_metric", "direction", "range", "reducer"}
        object_fields(score, fields, fields, name)
        identifier(score["source_metric"], name)
        bounds = score["range"]
        if (
            score["direction"] not in ("maximize", "minimize")
            or score["reducer"] != "task-macro-mean"
            or not isinstance(bounds, list)
            or len(bounds) != 2
            or any(
                type(number) not in (int, float) or not math.isfinite(number) for number in bounds
            )
            or bounds[0] > bounds[1]
        ):
            raise BenchmarkError("invalid native score definition", name)
    if "raw_metrics" in manifest:
        registry = manifest["raw_metrics"]
        object_fields(
            registry, {"schema_version", "metrics"}, {"schema_version", "metrics"}, "raw_metrics"
        )
        if registry["schema_version"] != "1" or not isinstance(registry["metrics"], list):
            raise BenchmarkError("unsupported raw metric registry", "raw_metrics")
        ids = []
        for metric in registry["metrics"]:
            if not isinstance(metric, dict):
                raise BenchmarkError("raw metric must be an object", "raw_metrics")
            identifier(metric.get("id"), "raw_metrics")
            ids.append(metric["id"])
        if len(set(ids)) != len(ids):
            raise BenchmarkError("duplicate raw metric id", "raw_metrics")
    if not isinstance(manifest["tasks"], list) or not manifest["tasks"]:
        raise BenchmarkError("manifest requires tasks", "tasks")
    ids = []
    for task in manifest["tasks"]:
        object_fields(task, {"task_id", "task_digest"}, {"task_id", "task_digest"}, "tasks")
        value = task["task_id"]
        if not isinstance(value, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", value
        ):
            raise BenchmarkError("invalid manifest task id", "tasks")
        ids.append(value)
        if not isinstance(task["task_digest"], str) or not re.fullmatch(
            r"sha256:[a-f0-9]{64}", task["task_digest"]
        ):
            raise BenchmarkError("invalid manifest task digest", "tasks")
    if ids != sorted(set(ids)):
        raise BenchmarkError("manifest task IDs must be unique and sorted", "tasks")
    if not isinstance(manifest["dataset_digest"], str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", manifest["dataset_digest"]
    ):
        raise BenchmarkError("invalid manifest dataset digest", "dataset_digest")


def build_manifest(manifest: dict, tasks: list[dict]) -> dict:
    try:
        result = subprocess.run(
            [
                os.environ.get("GEAR_NODE", "node"),
                str(Path(__file__).with_name("manifest_codec.cjs")),
            ],
            input=json.dumps({"manifest": manifest, "tasks": tasks}, allow_nan=False),
            text=True,
            capture_output=True,
            timeout=30,
            check=True,
        )
        return json_value(result.stdout, "benchmark.adapter.json")
    except (OSError, subprocess.SubprocessError) as error:
        raise BenchmarkError(
            "Node runtime is required for Harbor manifest v1 hashing", "benchmark.adapter.json"
        ) from error


def read_metadata(root: Path, entries: list[dict], payload: Payload) -> dict:
    files, manifest = [], None
    for name in ROOT_FILES:
        if (root / name).exists() or (root / name).is_symlink():
            path = contained_file(root, name)
            value = json_value(read_text(path), name)
            file = payload.add(name, path.read_bytes())
            files.append(file)
            if name == "benchmark.adapter.json":
                manifest = value
    if manifest is not None:
        validate_manifest(manifest)
        expected = build_manifest(
            manifest, [{"id": entry["task"]["id"], "files": entry["files"]} for entry in entries]
        )
        if (
            expected["tasks"] != manifest["tasks"]
            or expected["dataset_digest"] != manifest["dataset_digest"]
        ):
            raise BenchmarkError(
                "native benchmark manifest task set, content or dataset digest mismatch",
                "benchmark.adapter.json",
            )
    return {"files": files, "manifest": manifest}


def import_metadata(
    metadata: dict, task_files: list[dict], task_ids: list[str], payload: Payload
) -> list[dict]:
    files = {file["path"]: file for file in metadata["files"]}
    if metadata["manifest"] is not None:
        files.setdefault(
            "source-benchmark.adapter.json",
            {**files["benchmark.adapter.json"], "path": "source-benchmark.adapter.json"},
        )
        derived = build_manifest(
            metadata["manifest"],
            [
                {
                    "id": identifier,
                    "files": [
                        {**file, "path": file["path"][len("tasks/" + identifier + "/") :]}
                        for file in task_files
                        if file["path"].startswith("tasks/" + identifier + "/")
                    ],
                }
                for identifier in task_ids
            ],
        )
        files["benchmark.adapter.json"] = payload.text(
            "benchmark.adapter.json", json.dumps(derived, ensure_ascii=False, indent=2) + "\n"
        )
    return [{**file, "path": "tasks/" + file["path"]} for file in files.values()]


def seal_harbor(benchmark: dict, destination: str, task_ids: list[str]) -> None:
    from gear.canonical import digest

    if digest({key: value for key, value in benchmark.items() if key != "digest"}) != benchmark.get(
        "digest"
    ):
        raise BenchmarkError("frozen benchmark digest mismatch", "benchmark")
    template = benchmark.get("adapter_manifest")
    if template is None:
        return
    if implementation_digest() != benchmark.get("manifest_source_digest"):
        raise BenchmarkError(
            "native manifest codec changed; use the admitted runtime", "manifest_source_digest"
        )
    if (
        not task_ids
        or len(set(task_ids)) != len(task_ids)
        or not set(task_ids) <= {task["id"] for task in benchmark["tasks"]}
    ):
        raise BenchmarkError("expected an exact admitted task subset", "task_ids")
    root, tasks = Path(destination).resolve(), []
    for identifier in task_ids:
        files = []
        task = root / identifier
        for path in sorted(task.rglob("*")):
            if path.is_symlink():
                raise BenchmarkError("native tasks cannot contain symlinks", str(path))
            if path.is_dir():
                continue
            path = contained_file(task, path.relative_to(task).as_posix())
            files.append(
                {
                    "path": path.relative_to(task).as_posix(),
                    "digest": bytes_digest(path.read_bytes()),
                    "executable": bool(path.stat().st_mode & 0o111),
                }
            )
        tasks.append({"id": identifier, "files": files})
    manifest = build_manifest(template, tasks)
    (root / "benchmark.adapter.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def restore_metadata(benchmark: dict, root: Path):
    for file in benchmark.get("native_root_files", []):
        if file["path"] not in ROOT_FILES:
            raise BenchmarkError("unsupported frozen native root file", file["path"])
        (root / file["path"]).write_bytes(content_bytes(file, benchmark["native_blobs"]))


def implementation_digest() -> str:
    from gear.canonical import digest

    return digest(
        {
            name: bytes_digest(Path(__file__).with_name(name).read_bytes())
            for name in ("manifest.py", "manifest_codec.cjs")
        }
    )
