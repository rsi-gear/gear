"""Versioned author-data import plans. Planning is read-only; the application publishes files."""

from __future__ import annotations

import base64
import json
from pathlib import Path

from gear.canonical import digest

from .compiler import bytes_digest, compile_rows, contained_file
from .payload import Payload, used_blobs
from .source import BenchmarkError, read_rows
from .splits import propose_splits


def text_file(path: str, text: str) -> dict:
    return frozen_file(path, text.encode("utf-8"))


def frozen_file(path: str, data: bytes, executable: bool = False) -> dict:
    return {
        "path": path,
        "digest": bytes_digest(data),
        "content_base64": base64.b64encode(data).decode("ascii"),
        "executable": executable,
    }


def prepare_import(
    source: str,
    template: str = "text",
    mode: str = "holdout",
    resource_root: str | None = None,
    image_digests: dict[str, str] | None = None,
) -> dict:
    if template == "harbor":
        return prepare_native_import(source, mode, image_digests or {})
    path = Path(source).absolute()
    requested_root = Path(resource_root).absolute() if resource_root else path.parent
    root = requested_root.resolve()
    try:
        relative = path.relative_to(requested_root).as_posix()
    except ValueError as error:
        raise BenchmarkError("source must be inside resource_root", source) from error
    path = contained_file(root, relative)
    rows = read_rows(path)
    supplied = {
        row.get("id"): row.get("split", "")
        for _, row in rows
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    # Reuse all row/scorer/resource checks while postponing only the partition decision.
    compiled = compile_rows(
        root,
        {"template": template},
        path,
        [
            (line, {**row, "split": "seed"}) if isinstance(row, dict) else (line, row)
            for line, row in rows
        ],
    )
    splits = propose_splits(compiled["tasks"], supplied, mode)
    files, normalized = {}, []
    for task in sorted(compiled["tasks"], key=lambda value: value["id"]):
        attachments = []
        for resource in task["resources"]:
            name = "resources/" + resource["path"]
            item = {**resource, "path": name, "executable": False}
            if name in files and files[name] != item:
                raise BenchmarkError("attachment content changed while reading", resource["path"])
            files[name] = item
            attachments.append(name)
        normalized.append(
            {
                "id": task["id"],
                "instruction": task["instruction"],
                "family": task["family"],
                "tags": task["tags"],
                "attachments": attachments,
                "expected": compiled["verifiers"][task["id"]]["expected"],
            }
        )
    files["tasks.jsonl"] = text_file(
        "tasks.jsonl",
        "".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in normalized),
    )
    files["splits.json"] = text_file(
        "splits.json", json.dumps(splits, ensure_ascii=False, indent=2) + "\n"
    )
    inputs = {
        "name": "tabular-v1",
        "source_digest": compiled["source_digest"],
        "implementation_digest": digest(
            {
                name: bytes_digest(Path(__file__).with_name(name).read_bytes())
                for name in (
                    "importer.py",
                    "source.py",
                    "compiler.py",
                    "splits.py",
                    "scorers.py",
                    "runtime_limits.py",
                    "payload.py",
                    "limits.py",
                    "limits.json",
                    "environment.py",
                    "manifest.py",
                    "manifest_codec.cjs",
                )
            }
        ),
    }
    ordered = [files[name] for name in sorted(files)]
    if sum(len(base64.b64decode(file["content_base64"])) for file in ordered) > 16 * 1024 * 1024:
        raise BenchmarkError("imported source and resources exceed 16 MiB", source)
    payload = Payload()
    ordered = [
        payload.add(file["path"], base64.b64decode(file["content_base64"]), file["executable"])
        for file in ordered
    ]
    identity = digest({"importer": inputs, "files": ordered, "template": template, "mode": mode})
    directory = "benchmarks/import-" + identity[7:31]
    config = {
        "version": 1,
        "source": directory + "/tasks.jsonl",
        "resource_root": directory,
        "splits": directory + "/splits.json",
        "template": template,
        "importer": inputs,
    }
    body = {
        "version": 2,
        "directory": directory,
        "config": config,
        "files": ordered,
        "blobs": payload.blobs,
        "directories": [],
        "validation_mode": mode,
        "summary": {
            "tasks": len(normalized),
            "splits": splits,
            "scorer": template,
            "checks": compiled["checks"],
            "model_requests": 0,
        },
    }
    return {**body, "digest": digest(body)}


def prepare_native_import(source: str, mode: str, image_digests: dict[str, str]) -> dict:
    import tomli_w

    from .manifest import import_metadata
    from .native import native_tasks, pin_dockerfile, pin_image

    entries, payload, metadata = native_tasks(Path(source))
    splits = propose_splits(
        [entry["task"] for entry in entries],
        {entry["task"]["id"]: entry["split"] for entry in entries},
        mode,
    )
    original = digest(
        {
            "tasks": [
                {"files": entry["files"], "directories": entry["directories"]} for entry in entries
            ],
            "metadata": metadata["files"],
        }
    )
    files, directories = [], []
    for entry in entries:
        identifier = entry["task"]["id"]
        directories.extend("tasks/" + identifier + "/" + name for name in entry["directories"])
        config = entry["config"]
        config.setdefault("environment", {}).pop("docker_image", None)
        # Gear must build the native image plus its candidate carrier, not bypass it with a prebuilt image.
        config.get("verifier", {}).get("environment", {}).pop("docker_image", None)
        native = {file["path"]: file for file in entry["files"]}
        native["task.toml"] = payload.text("task.toml", tomli_w.dumps(config))
        for path, text in entry["dockerfiles"].items():
            native[path] = payload.text(
                path, pin_dockerfile(text, image_digests, identifier + "/" + path)
            )
        layout = entry["environment_layout"]
        for location, image in layout["images"].items():
            role, service = location.split(":", 1)
            layout["compositions"][role + "/docker-compose.yaml"]["services"][service]["image"] = (
                pin_image(image, image_digests, identifier + "/" + location)
            )
        for path in layout["removed"]:
            native.pop(path)
        for path, composition in layout["compositions"].items():
            native[path] = payload.text(
                path, json.dumps(composition, ensure_ascii=False, indent=2) + "\n"
            )
        files.extend(
            {**file, "path": "tasks/" + identifier + "/" + name}
            for name, file in sorted(native.items())
        )
    files.extend(
        import_metadata(metadata, files, [entry["task"]["id"] for entry in entries], payload)
    )
    files.append(
        payload.text("splits.json", json.dumps(splits, ensure_ascii=False, indent=2) + "\n")
    )
    importer = {
        "name": "harbor-v2",
        "source_digest": original,
        "implementation_digest": digest(
            {
                name: bytes_digest(Path(__file__).with_name(name).read_bytes())
                for name in (
                    "importer.py",
                    "native.py",
                    "splits.py",
                    "source.py",
                    "runtime_limits.py",
                    "payload.py",
                    "limits.py",
                    "limits.json",
                    "environment.py",
                    "manifest.py",
                    "manifest_codec.cjs",
                )
            }
        ),
    }
    identity = digest(
        {"files": files, "directories": directories, "importer": importer, "mode": mode}
    )
    directory = "benchmarks/import-" + identity[7:31]
    config = {
        "version": 1,
        "source": directory + "/tasks",
        "template": "harbor",
        "splits": directory + "/splits.json",
        "importer": importer,
    }
    body = {
        "version": 2,
        "directory": directory,
        "config": config,
        "files": files,
        "blobs": used_blobs(files, payload.blobs),
        "directories": directories,
        "validation_mode": mode,
        "summary": {
            "tasks": len(entries),
            "splits": splits,
            "scorer": "native Harbor verifier",
            "images": image_digests,
            "checks": {
                "static": "passed",
                "verifier_fixtures": "not_run",
                "environment": "not_run",
            },
            "model_requests": 0,
        },
    }
    return {**body, "digest": digest(body)}
