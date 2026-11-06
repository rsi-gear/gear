"""Resolve frozen Harbor build contexts without inheriting host Compose configuration."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath

import yaml

from .compiler import contained_directory, contained_file
from .source import BenchmarkError

SERVICE_FIELDS = {
    "build",
    "image",
    "platform",
    "command",
    "entrypoint",
    "environment",
    "depends_on",
    "healthcheck",
    "working_dir",
    "user",
    "init",
    "hostname",
    "stop_signal",
    "stop_grace_period",
    "labels",
    "read_only",
    "tmpfs",
    "expose",
    "restart",
}


class ComposeLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        pairs = self.construct_pairs(node, deep=deep)
        result = {}
        for key, value in pairs:
            if not isinstance(key, str) or key in result:
                raise ValueError("Compose keys must be unique strings")
            result[key] = value
        return result


def read_text(path: Path) -> str:
    if path.stat().st_size > 16 * 1024 * 1024:
        raise BenchmarkError("native text file exceeds 16 MiB", str(path))
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeError as error:
        raise BenchmarkError("native text must be UTF-8", str(path)) from error


def local_path(value, location: str, allow_dot=False) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or "\0" in value
        or PurePosixPath(value).is_absolute()
        or ".." in PurePosixPath(value).parts
        or str(PurePosixPath(value)) != value
        or (value == "." and not allow_dot)
    ):
        raise BenchmarkError("build inputs must use contained local paths", location)
    return value


def literal(value):
    if isinstance(value, str):
        if re.search(r"\$", value.replace("$$", "")):
            raise ValueError("resolve host variable interpolation before importing Compose")
    elif isinstance(value, dict):
        for key, item in value.items():
            literal(key)
            literal(item)
    elif isinstance(value, list):
        for item in value:
            literal(item)


def read_environment(root: Path, config: dict) -> dict:
    dockerfiles, compositions, removed, images, mains = {}, {}, [], {}, {}
    for role, settings in (
        ("environment", config.get("environment", {})),
        ("tests", config.get("verifier", {}).get("environment", {})),
    ):
        paths = [role + "/docker-compose." + suffix for suffix in ("yaml", "yml")]
        existing = [path for path in paths if (root / path).exists()]
        if len(existing) > 1:
            raise BenchmarkError("use one Compose file per environment", str(root / role))
        composition = {"services": {"main": {}}}
        if existing:
            location = existing[0]
            try:
                text = read_text(contained_file(root, location))
                if any(
                    isinstance(token, (yaml.AliasToken, yaml.AnchorToken))
                    for token in yaml.scan(text)
                ):
                    raise ValueError("expand Compose aliases before importing")
                composition = yaml.load(text, Loader=ComposeLoader)
                if not isinstance(composition, dict) or set(composition) - {"services", "version"}:
                    raise ValueError(
                        "Compose supports services and version; external resources are not frozen"
                    )
                literal(composition)
                if not isinstance(composition.get("services"), dict) or not composition["services"]:
                    raise ValueError("Compose requires services")
                # Harbor supplies main even when the author file only declares sidecars.
                composition["services"].setdefault("main", {})
                for name, service in composition["services"].items():
                    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name) or not isinstance(
                        service, dict
                    ):
                        raise ValueError("invalid Compose service")
                    if set(service) - SERVICE_FIELDS:
                        raise ValueError(
                            "unsupported Compose service fields: "
                            + ", ".join(sorted(set(service) - SERVICE_FIELDS))
                        )
                    environment = service.get("environment", {})
                    if (
                        isinstance(environment, dict)
                        and any(value is None for value in environment.values())
                    ) or (
                        isinstance(environment, list)
                        and any(
                            not isinstance(value, str) or "=" not in value for value in environment
                        )
                    ):
                        raise ValueError(
                            "Compose environment must provide values, not inherit host variables"
                        )
                    if not isinstance(environment, (list, dict)):
                        raise ValueError("Compose environment must be a mapping or list")
                json.dumps(composition, allow_nan=False)
            except (yaml.YAMLError, ValueError, TypeError) as error:
                raise BenchmarkError(str(error), str(root / location)) from error
            compositions[role + "/docker-compose.yaml"] = composition
            if location.endswith(".yml"):
                removed.append(location)
        for name, service in composition["services"].items():
            location = role + ":" + name
            image = service.get("image")
            build = service.get("build")
            if name == "main" and settings.get("docker_image"):
                if image or build:
                    raise BenchmarkError(
                        "choose task docker_image or Compose main build/image", location
                    )
                image = settings["docker_image"]
            if image and build:
                raise BenchmarkError(
                    "choose build or image; both have ambiguous pull behavior", location
                )
            if image is not None and (not isinstance(image, str) or not image):
                raise BenchmarkError("service image must be a nonempty string", location)
            if image and name != "main":
                images[location] = image
                continue
            if image:
                # A carrier requires a build. Keep its context separate from private task files.
                context = role + "/gear-main-image" if existing else role
                dockerfile = context + "/Dockerfile"
                if existing and (root / context).exists():
                    raise BenchmarkError("reserved carrier image context already exists", context)
                dockerfiles[dockerfile] = "FROM " + image + "\n"
                if existing:
                    service.pop("image", None)
                    service["build"] = {"context": "gear-main-image", "dockerfile": "Dockerfile"}
                mains[role] = {"context": context, "dockerfile": dockerfile}
                continue
            if build is None and name != "main":
                raise BenchmarkError("Compose service requires build or image", location)
            if (
                build is None
                and role == "tests"
                and not (root / role / "Dockerfile").exists()
                and not existing
            ):
                continue
            if build is None:
                build = {"context": ".", "dockerfile": "Dockerfile"}
            elif isinstance(build, str):
                build = {"context": build}
            if not isinstance(build, dict) or set(build) - {
                "context",
                "dockerfile",
                "args",
                "target",
            }:
                raise BenchmarkError(
                    "Compose build requires local context/dockerfile and explicit args", location
                )
            if name == "main" and "target" in build:
                raise BenchmarkError(
                    "main build target must use the final stage for the Target carrier", location
                )
            args = build.get("args", {})
            if not isinstance(args, dict) or any(value is None for value in args.values()):
                raise BenchmarkError("build args require explicit values", location)
            relative = local_path(build.get("context", "."), location, allow_dot=True)
            context = role if relative == "." else role + "/" + relative
            contained_directory(root, context)
            dockerfile = context + "/" + local_path(build.get("dockerfile", "Dockerfile"), location)
            dockerfiles[dockerfile] = read_text(contained_file(root, dockerfile))
            if existing:
                service["build"] = {
                    **build,
                    "context": relative,
                    "dockerfile": build.get("dockerfile", "Dockerfile"),
                }
            if name == "main":
                mains[role] = {"context": context, "dockerfile": dockerfile}
    return {
        "dockerfiles": dockerfiles,
        "compositions": compositions,
        "removed": removed,
        "images": images,
        "mains": mains,
    }


def source_bytes() -> bytes:
    return Path(__file__).read_bytes()
