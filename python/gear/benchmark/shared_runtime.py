"""Prepare opt-in shared task images and bind them into a new native dataset.

This producer runs before benchmark admission. Existing frozen benchmarks and
the host Harbor executor are unchanged. Image builds/publication remain explicit
operator actions; bind accepts only pinned, locally inspectable images.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

from gear.canonical import digest

from .manifest import build_manifest
from .native import PINNED, native_tasks
from .payload import NativeMaterializer
from .shared_runtime_plan import fail, fields, instructions, plan_tasks, under

LABEL = "xyz.gear.shared-runtime.recipe"


def json_write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def tree_records(root):
    result = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            fail("prepared tree contains a symlink")
        if path.is_dir():
            result.append({"path": path.relative_to(root).as_posix(), "directory": True})
        elif path.is_file():
            from .compiler import bytes_digest

            result.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "digest": bytes_digest(path.read_bytes()),
                    "executable": bool(path.stat().st_mode & 0o111),
                }
            )
        else:
            fail("prepared tree contains a special file")
    return result


def separate_paths(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output or source in output.parents or output in source.parents:
        fail("source and destination must not overlap")
    if output.exists():
        fail("destination must be new")
    return source, output


def prepare(source, declaration, destination):
    source, output = separate_paths(source, destination)
    entries, payload, metadata = native_tasks(source)
    recipes, tasks = plan_tasks(entries, payload.blobs, declaration)
    if metadata["manifest"] is None:
        fail("shared runtime preparation requires an admitted native v1 dataset manifest")
    output.mkdir(parents=True, mode=0o700)
    writer = NativeMaterializer(payload.blobs)
    try:
        contexts, templates = output / "contexts", output / "templates"
        contexts.mkdir()
        templates.mkdir()
        auxiliary = output / "metadata"
        auxiliary.mkdir()
        for file in metadata["files"]:
            if file["path"] != "benchmark.adapter.json":
                writer.write(file, auxiliary / file["path"])
        for key, recipe in recipes.items():
            root = contexts / key.removeprefix("sha256:")
            root.mkdir()
            for name in recipe["directories"]:
                (root / name).mkdir(parents=True, exist_ok=True)
            for file in recipe["files"]:
                target = root / file["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                writer.write(file, target)
            (root / "Dockerfile").write_text(
                recipe["dockerfile"].rstrip("\n") + f'\nLABEL {LABEL}="{key}"\n',
                encoding="utf-8",
            )
        bindings = []
        removed_bytes = 0
        for task in tasks:
            entry, removed = task["entry"], task["removed"]
            identifier = entry["task"]["id"]
            root = templates / identifier
            root.mkdir()
            retained = [file for file in entry["files"] if file["path"] not in removed]
            replacements = {item["dockerfile"]: item["tail"] for item in task["factors"]}
            # Image-only empty directories are represented in the image recipe;
            # preserve all other empty native directories exactly.
            for name in entry["directories"]:
                if (
                    name not in task["consumed_directories"]
                    or any(under(p, name) for p in task["needed_directories"])
                    or not any(under(name, p) for p in declaration["image_only"])
                    or any(under(file["path"], name) for file in retained)
                ):
                    (root / name).mkdir(parents=True, exist_ok=True)
            for file in retained:
                target = root / file["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                if file["path"] in replacements:
                    # Do not register a file with NativeMaterializer and then
                    # rewrite it: subsequent reflinks would use a changed blob.
                    target.write_text(replacements[file["path"]], encoding="utf-8")
                    target.chmod(0o755 if file["executable"] else 0o644)
                else:
                    writer.write(file, target)
            removed_bytes += sum(f["size"] for f in entry["files"] if f["path"] in removed)
            for item in task["factors"]:
                # Templates are not executable tasks. Binding produces all FROM
                # references and a new manifest as the final publication step.
                bindings.append(
                    {"task": identifier, "dockerfile": item["dockerfile"], "recipe": item["key"]}
                )
        body = {
            "schema_version": "1",
            "plan": declaration,
            "recipes": recipes,
            "bindings": bindings,
            "source_manifest": metadata["manifest"],
            "templates_digest": digest(tree_records(templates)),
            "contexts_digest": digest(tree_records(contexts)),
            "metadata_digest": digest(tree_records(auxiliary)),
            "removed_task_bytes": removed_bytes,
        }
        result = {**body, "digest": digest(body)}
        json_write(output / "prepared.json", result)
        return result
    except BaseException:
        shutil.rmtree(output)
        raise


def inspect_image(reference):
    result = subprocess.run(
        ["docker", "image", "inspect", reference],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or len(rows) != 1:
        fail("image inspection must return exactly one image")
    return rows[0]


def verify_image(reference, recipe, key, inspect=inspect_image):
    if not isinstance(reference, str) or not PINNED.fullmatch(reference):
        fail("bind requires an immutable repository@sha256 manifest reference")
    image = inspect(reference)
    if reference not in image.get("RepoDigests", []):
        fail("local image does not attest the requested repository digest")
    if f"{image.get('Os')}/{image.get('Architecture')}" != recipe["platform"]:
        fail("shared image platform mismatch")
    config = image.get("Config", {})
    if config.get("OnBuild") or config.get("Volumes"):
        fail("shared images with ONBUILD or implicit volumes are unsupported")
    if config.get("Labels", {}).get(LABEL) != key:
        fail("shared image was not built with the expected recipe identity")
    base = next(argument for _, op, argument in instructions(recipe["dockerfile"]) if op == "FROM")
    base_image = inspect(base)
    if f"{base_image.get('Os')}/{base_image.get('Architecture')}" != recipe["platform"]:
        fail("locally inspected base image platform differs from the prepared runtime")
    base_config = base_image.get("Config", {})
    if base_config.get("OnBuild") or base_config.get("Volumes"):
        fail("base image ONBUILD or implicit volumes require the original build path")


def bind(prepared, images, destination, *, inspect=inspect_image):
    source, output = separate_paths(prepared, destination)
    record = json.loads((source / "prepared.json").read_text(encoding="utf-8"))
    body = {key: value for key, value in record.items() if key != "digest"}
    if record.get("schema_version") != "1" or digest(body) != record.get("digest"):
        fail("prepared runtime identity mismatch")
    if any(
        not isinstance(task, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", task)
        for task in record["plan"]["tasks"]
    ):
        fail("invalid prepared task ID")
    if not isinstance(images, dict) or set(images) != set(record["recipes"]):
        fail("provide exactly one pinned image for every recipe")
    for kind in ("templates", "contexts", "metadata"):
        records = tree_records(source / kind)
        if digest(records) != record[kind + "_digest"]:
            fail("prepared " + kind + " changed")
        if kind == "metadata" and any(
            item["path"] not in {"source-manifest.json", "source-benchmark.adapter.json"}
            or item.get("directory")
            for item in records
        ):
            fail("unexpected prepared root metadata")
    for key, recipe in record["recipes"].items():
        if digest(recipe) != key:
            fail("recipe identity mismatch")
        verify_image(images[key], recipe, key, inspect)
    output.mkdir(parents=True, mode=0o700)
    try:
        shutil.copytree(source / "templates", output, dirs_exist_ok=True)
        if digest(tree_records(output)) != record["templates_digest"]:
            fail("templates changed while binding")
        for item in record["bindings"]:
            fields(item, {"task", "dockerfile", "recipe"})
            from .environment import local_path

            task = local_path(item["task"], "shared_runtime")
            if task not in record["plan"]["tasks"]:
                fail("binding references an undeclared task")
            dockerfile = local_path(item["dockerfile"], "shared_runtime")
            path = output / task / dockerfile
            path.write_text(
                "FROM " + images[item["recipe"]] + "\n" + path.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
        provenance = {
            "protocol": "gear-shared-runtime-binding@1",
            "prepared_digest": record["digest"],
            "images": images,
            "source_dataset": record["source_manifest"]["dataset_digest"],
        }
        # Put provenance inside every task so native admission and Gear's frozen
        # payload bind it, rather than relying on an untracked root sidecar.
        for identifier in record["plan"]["tasks"]:
            path = output / identifier / "gear-shared-runtime.json"
            if path.exists():
                fail("reserved shared runtime provenance file already exists")
            json_write(path, provenance)
        entries, _, _ = native_tasks(output)
        template = dict(record["source_manifest"])
        template["adapter"] = {**template["adapter"], "revision": digest(provenance)}
        manifest = build_manifest(
            template, [{"id": entry["task"]["id"], "files": entry["files"]} for entry in entries]
        )
        shutil.copytree(source / "metadata", output, dirs_exist_ok=True)
        copied_metadata = [
            item
            for item in tree_records(output)
            if not item.get("directory") and "/" not in item["path"]
        ]
        if digest(copied_metadata) != record["metadata_digest"]:
            fail("root metadata changed while binding")
        if not (output / "source-benchmark.adapter.json").exists():
            json_write(output / "source-benchmark.adapter.json", record["source_manifest"])
        json_write(output / "benchmark.adapter.json", manifest)
        return manifest
    except BaseException:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "bind"])
    parser.add_argument("--source", required=True)
    parser.add_argument("--input", required=True, help="plan JSON for prepare; image map for bind")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    value = json.loads(Path(args.input).read_text(encoding="utf-8"))
    operation = prepare if args.action == "prepare" else bind
    result = operation(args.source, value, args.out)
    print(
        json.dumps(
            {
                "output": str(Path(args.out).resolve()),
                "digest": result.get("digest", result.get("dataset_digest")),
            }
        )
    )


if __name__ == "__main__":
    main()
