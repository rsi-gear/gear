"""Frozen native Harbor tasks; private tests/solutions never enter public task objects."""

from __future__ import annotations

import re
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python 3.10 author tools remain supported.
    import tomli as tomllib

from gear.canonical import digest

from .compiler import bytes_digest, contained_directory, contained_file
from .environment import read_environment
from .environment import read_text as native_text
from .manifest import implementation_digest as manifest_digest
from .manifest import read_metadata
from .payload import Payload, used_blobs
from .payload import source_bytes as payload_source_bytes
from .runtime_limits import native_timeouts, source_bytes
from .scorers import source_bytes as scorer_source_bytes
from .source import BenchmarkError, apply_splits, json_value

PINNED = re.compile(r"[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}\Z")
FROM = re.compile(r"(?im)^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)([^\r\n]*)")


def native_tasks(source: Path) -> tuple[list[dict], Payload, dict]:
    if source.is_symlink() or not source.is_dir():
        raise BenchmarkError(
            "Harbor source must be a task directory or dataset directory", str(source)
        )
    task_directories = (
        [source]
        if (source / "task.toml").exists()
        else sorted(path for path in source.iterdir() if (path / "task.toml").is_file())
    )
    tasks, payload = [], Payload()
    directory_count = 0
    for directory in task_directories:
        identifier = directory.name
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", identifier):
            raise BenchmarkError("Harbor directory name must be a stable task ID", str(directory))
        if directory.is_symlink():
            raise BenchmarkError("Harbor task directories cannot be links", str(directory))
        root = directory.resolve()
        config_file = contained_file(root, "task.toml")
        try:
            config = tomllib.loads(native_text(config_file))
        except (ValueError, UnicodeError) as error:
            raise BenchmarkError(str(error), identifier + "/task.toml") from error
        if any(
            not isinstance(config.get(name, {}), dict)
            for name in ("metadata", "environment", "verifier")
        ) or not isinstance(config.get("verifier", {}).get("environment", {}), dict):
            raise BenchmarkError(
                "metadata, verifier and environment must be TOML tables", identifier + "/task.toml"
            )
        for environment in (
            config.get("environment", {}),
            config.get("verifier", {}).get("environment", {}),
        ):
            if "docker_image" in environment and (
                not isinstance(environment["docker_image"], str)
                or not environment["docker_image"].strip()
            ):
                raise BenchmarkError(
                    "docker_image must be a nonempty string", identifier + "/task.toml"
                )
        if config.get("steps") or config.get("environment", {}).get("os", "linux") != "linux":
            raise BenchmarkError(
                "this importer supports single-step Linux Harbor tasks", identifier + "/task.toml"
            )
        instruction = native_text(contained_file(root, "instruction.md"))
        if not instruction.strip():
            raise BenchmarkError("instruction is empty", identifier + "/instruction.md")
        contained_file(root, "tests/test.sh")
        metadata = config.get("metadata", {})
        family = (
            metadata.get("family")
            or metadata.get("domain")
            or metadata.get("category")
            or identifier
        )
        if not isinstance(family, str):
            raise BenchmarkError(
                "family/domain/category must be a string", identifier + "/task.toml:metadata"
            )
        tags = metadata.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise BenchmarkError("tags must be strings", identifier + "/task.toml:metadata.tags")
        split = metadata.get("split", "")
        if not isinstance(split, str) or split not in ("", "seed", "held_out"):
            raise BenchmarkError(
                "metadata.split must be seed or held_out",
                identifier + "/task.toml:metadata.split",
            )
        files, directories = [], []

        def visit(folder: Path):
            nonlocal directory_count
            for path in sorted(folder.iterdir()):
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    raise BenchmarkError(
                        "native Harbor files cannot be symlinks", identifier + "/" + relative
                    )
                if path.is_dir():
                    directory_count += 1
                    if directory_count > payload.limits["maxDirectories"]:
                        raise BenchmarkError(
                            "native payload exceeds maxDirectories in GEAR_BENCHMARK_LIMITS_JSON",
                            str(source),
                        )
                    directories.append(relative)
                    visit(path)
                else:
                    path = contained_file(root, relative)
                    if path.stat().st_size > payload.limits["maxUniqueBytes"]:
                        raise BenchmarkError(
                            "unique payload content exceeds maxUniqueBytes in GEAR_BENCHMARK_LIMITS_JSON",
                            relative,
                        )
                    files.append(
                        payload.add(relative, path.read_bytes(), bool(path.stat().st_mode & 0o111))
                    )

        visit(root)
        environment = read_environment(root, config)
        task = {
            "id": identifier,
            "instruction": instruction,
            "family": family,
            "tags": metadata.get("tags", []),
            "resources": [],
            "environment": digest(
                {
                    "files": [file for file in files if file["path"].startswith("environment/")],
                    "directories": [
                        path for path in directories if path.startswith("environment/")
                    ],
                }
            ),
        }
        tasks.append(
            {
                "task": task,
                "config": config,
                "timeouts": native_timeouts(config, identifier + "/task.toml"),
                "files": files,
                "directories": directories,
                "dockerfiles": environment["dockerfiles"],
                "environment_layout": environment,
                "split": split,
            }
        )
    if not tasks:
        raise BenchmarkError("Harbor dataset has no tasks", str(source))
    return tasks, payload, read_metadata(source.resolve(), tasks, payload)


def docker_images(dockerfile: str, location: str) -> list[str]:
    stages, images = set(), []
    matches = list(FROM.finditer(dockerfile))
    if not matches:
        raise BenchmarkError("Dockerfile requires FROM", location)
    for match in matches:
        name = match[2]
        if "$" in name or "\\" in name:
            raise BenchmarkError(
                "resolve Dockerfile ARG image references before importing", location
            )
        if name.lower() not in stages and name != "scratch":
            images.append(name)
        suffix = match[3].strip().split()
        if suffix and suffix[0].lower() == "as" and len(suffix) >= 2:
            stages.add(suffix[1].lower())
    return images


def required_images(source: str) -> list[str]:
    entries, _, _ = native_tasks(Path(source))
    images = {
        image for entry in entries for image in entry["environment_layout"]["images"].values()
    }
    images.update(
        image
        for entry in entries
        for path, text in entry["dockerfiles"].items()
        for image in docker_images(text, entry["task"]["id"] + "/" + path)
    )
    return sorted(image for image in images if not PINNED.fullmatch(image))


def pin_image(image: str, images: dict[str, str], location: str) -> str:
    pinned = images.get(image, image)
    if not PINNED.fullmatch(pinned):
        raise BenchmarkError(
            "prepare the image locally so its immutable digest can be resolved: " + image, location
        )
    return pinned


def pin_dockerfile(dockerfile: str, images: dict[str, str], location: str) -> str:
    external = set(docker_images(dockerfile, location))

    def replacement(match):
        name = match[2]
        if name not in external:
            return match[0]
        pinned = pin_image(name, images, location)
        return match[1] + pinned + match[3]

    return FROM.sub(replacement, dockerfile)


def compile_native(root: Path, config: dict) -> dict:
    source = contained_directory(root, config["source"])
    entries, payload, metadata = native_tasks(source)
    rows = [
        (index, {"id": entry["task"]["id"], "split": entry["split"]})
        for index, entry in enumerate(entries, 1)
    ]
    if "splits" in config:
        path = contained_file(root, config["splits"])
        rows = apply_splits(rows, json_value(path.read_text(), path.name), path.name)
    splits = {"seed": [], "held_out": []}
    families, inputs, tasks, verifiers = {}, {}, [], {}
    for (_, row), entry in zip(rows, entries):
        task, files = entry["task"], entry["files"]
        if entry["config"].get("environment", {}).get("docker_image") or entry["config"].get(
            "verifier", {}
        ).get("environment", {}).get("docker_image"):
            raise BenchmarkError(
                "import prebuilt native tasks first so Gear can install the Target carrier",
                task["id"] + "/task.toml:environment.docker_image",
            )
        split = row["split"]
        if split not in splits:
            raise BenchmarkError(
                "explicit split is required for each native task", task["id"] + ":split"
            )
        if (
            families.setdefault(task["family"], split) != split
            or inputs.setdefault(digest(task["instruction"]), split) != split
        ):
            raise BenchmarkError(
                "family or duplicate instruction crosses seed and held_out", task["id"] + ":split"
            )
        # Admission requires already pinned FROM references; no image lookup during compile/resume.
        for path, text in entry["dockerfiles"].items():
            pin_dockerfile(text, {}, task["id"] + "/" + path)
        layout = entry["environment_layout"]
        if (
            layout["removed"]
            or any(
                "image" in compose["services"]["main"]
                for compose in layout["compositions"].values()
            )
            or any(
                not (
                    (source if (source / "task.toml").exists() else source / task["id"])
                    / main["dockerfile"]
                ).is_file()
                for main in layout["mains"].values()
            )
        ):
            raise BenchmarkError("import native image/Compose tasks before compiling", task["id"])
        for location, image in layout["images"].items():
            pin_image(image, {}, task["id"] + "/" + location)
        splits[split].append(task["id"])
        tasks.append({**task, "digest": digest(task)})
        body = {
            "expected": None,
            "rule": {"kind": "harbor"},
            "fixtures": [],
            "native_files": files,
            "native_directories": entry["directories"],
            "native_environment": {
                "mains": layout["mains"],
                "compose": sorted(layout["compositions"]),
            },
        }
        verifiers[task["id"]] = {**body, "digest": digest(body)}
    if not splits["seed"]:
        raise BenchmarkError("benchmark requires seed tasks", "split")
    body = {
        "version": 1,
        "tasks": tasks,
        "verifiers": verifiers,
        "splits": splits,
        "source_digest": digest(
            {
                "tasks": [
                    {"files": entry["files"], "directories": entry["directories"]}
                    for entry in entries
                ],
                "metadata": metadata["files"],
            }
        ),
        "native_blobs": used_blobs(
            [file for entry in entries for file in entry["files"]] + metadata["files"],
            payload.blobs,
        ),
        "native_root_files": metadata["files"],
        "adapter_manifest": metadata["manifest"],
        "manifest_source_digest": manifest_digest(),
        "native_source_digest": bytes_digest(Path(__file__).read_bytes()),
        "environment_source_digest": bytes_digest(
            Path(__file__).with_name("environment.py").read_bytes()
        ),
        "payload_source_digest": bytes_digest(payload_source_bytes()),
        "execution_timeouts": {entry["task"]["id"]: entry["timeouts"] for entry in entries},
        "runtime_limits_source_digest": bytes_digest(source_bytes()),
        "scorer_source_digest": bytes_digest(scorer_source_bytes()),
        "checks": {"static": "passed", "verifier_fixtures": "not_run", "environment": "not_run"},
        **({"importer": config["importer"]} if "importer" in config else {}),
    }
    return {**body, "digest": digest(body)}
