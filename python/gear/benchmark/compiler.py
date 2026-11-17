"""Compile CSV/JSONL author inputs into public tasks and private verifier resources."""

from __future__ import annotations

import base64
import hashlib
import re
from copy import deepcopy
from pathlib import Path

from gear.canonical import digest

from .runtime_limits import source_bytes, template_timeouts
from .scorers import fixtures, score_output
from .scorers import source_bytes as scorer_source_bytes
from .source import BenchmarkError, apply_splits, json_value, read_rows


def compile_benchmark(root: str | Path, config: dict) -> dict:
    root = Path(root).resolve()
    if (
        not isinstance(config, dict)
        or set(config)
        - {
            "version",
            "source",
            "template",
            "normalization",
            "fixtures",
            "splits",
            "importer",
            "resource_root",
            "scorer",
        }
        or config.get("version") != 1
    ):
        raise BenchmarkError("unsupported benchmark fields or version", "benchmark.yaml")
    if config.get("template") not in ("python", "llm") and "scorer" in config:
        raise BenchmarkError("scorer requires the python or llm template", "benchmark.yaml:scorer")
    if config.get("template") == "harbor":
        from .native import compile_native

        return compile_native(root, config)
    source = contained_file(root, config.get("source"))
    rows = read_rows(source)
    split_identity = None
    if "splits" in config:
        split_file = contained_file(root, config["splits"])
        manifest = json_value(split_file.read_text(encoding="utf-8"), split_file.name)
        rows = apply_splits(rows, manifest, split_file.name)
        split_identity = bytes_digest(split_file.read_bytes())
    return compile_rows(root, config, source, rows, split_identity)


def compile_rows(root: Path, config: dict, source: Path, rows: list, split_identity=None) -> dict:
    resource_root = (
        contained_directory(root, config["resource_root"]) if "resource_root" in config else root
    )
    template = config.get("template", "text")
    if template not in ("text", "json", "files", "python", "llm"):
        raise BenchmarkError(
            "template must be text, json, files, python or llm", "benchmark.yaml:template"
        )
    normalization = config.get("normalization", {})
    if (
        not isinstance(normalization, dict)
        or set(normalization) - {"trim", "casefold", "collapse_whitespace"}
        or any(type(v) is not bool for v in normalization.values())
    ):
        raise BenchmarkError(
            "unknown normalization option or nonboolean value",
            "benchmark.yaml:normalization",
        )
    rule = {"kind": template, **normalization}
    if template in ("python", "llm"):
        from .llm_scorer import validate_llm_scorer
        from .python_scorer import freeze_python_scorer

        if normalization:
            raise BenchmarkError(
                "Advanced scorers own their normalization", "benchmark.yaml:normalization"
            )
        rule["scorer"] = (
            freeze_python_scorer(root, config.get("scorer"))
            if template == "python"
            else validate_llm_scorer(config.get("scorer"))
        )
    tasks, verifiers, seen, splits, families = (
        [],
        {},
        set(),
        {"seed": [], "held_out": []},
        {},
    )
    inputs: dict[str, str] = {}
    for index, row in rows:
        location = f"{source.name}:{index}"
        if not isinstance(row, dict) or set(row) - {
            "id",
            "instruction",
            "expected",
            "family",
            "split",
            "attachments",
            "tags",
        }:
            raise BenchmarkError("unknown task fields or invalid task row", location)
        identifier = row.get("id")
        if (
            not isinstance(identifier, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", identifier)
            or identifier in seen
        ):
            raise BenchmarkError("task id is missing or duplicated", location + ":id")
        if not isinstance(row.get("instruction"), str) or not row["instruction"].strip():
            raise BenchmarkError("instruction is empty", location + ":instruction")
        if row.get("split") not in splits:
            raise BenchmarkError("explicit split must be seed or held_out", location + ":split")
        if "expected" not in row:
            raise BenchmarkError("expected value is required", location + ":expected")
        expected = row["expected"]
        if template in ("json", "files") and isinstance(expected, str):
            try:
                expected = json_value(expected, location + ":expected")
            except ValueError as error:
                raise BenchmarkError(
                    "expected must contain JSON assertions", location + ":expected"
                ) from error
        if not isinstance(config.get("fixtures", {}), dict):
            raise BenchmarkError("fixtures must be a task/fixture map", "benchmark.yaml:fixtures")
        try:
            golden = (
                config.get("fixtures", {})[identifier]
                if identifier in config.get("fixtures", {})
                else fixtures(expected, rule)
            )
        except (ValueError, TypeError, AttributeError) as error:
            raise BenchmarkError(str(error), location + ":expected") from error
        if (
            not isinstance(golden, list)
            or any(
                not isinstance(item, dict)
                or set(item) - {"actual", "artifacts", "score"}
                or not isinstance(item.get("actual"), str)
                or type(item.get("score")) not in (int, float)
                or item["score"] not in (0, 1)
                or not isinstance(item.get("artifacts", {}), dict)
                or any(
                    not isinstance(key, str) or not isinstance(value, str)
                    for key, value in item.get("artifacts", {}).items()
                )
                for item in golden
            )
            or not {0, 1}.issubset({item.get("score") for item in golden})
        ):
            raise BenchmarkError(
                "scorer needs a positive and negative fixture", location + ":fixtures"
            )
        for fixture in golden:
            if template in ("python", "llm"):
                if set(fixture.get("artifacts", {})) - set(rule["scorer"]["artifacts"]):
                    raise BenchmarkError(
                        "fixture contains undeclared artifacts", location + ":fixtures"
                    )
                continue
            try:
                scored = score_output(fixture["actual"], expected, rule, fixture.get("artifacts"))
            except (ValueError, TypeError, KeyError) as error:
                raise BenchmarkError(str(error), location + ":fixtures") from error
            if scored.value != fixture["score"]:
                raise BenchmarkError("scorer fixture failed", location + ":fixtures")
        resources = []
        attachments = row.get("attachments", [])
        if isinstance(attachments, str):
            attachments = [name.strip() for name in attachments.split(";") if name.strip()]
        if not isinstance(attachments, list) or any(
            not isinstance(name, str) for name in attachments
        ):
            raise BenchmarkError(
                "attachments must be relative file paths", location + ":attachments"
            )
        resource_paths: set[str] = set()
        for name in attachments:
            path = contained_file(resource_root, name)
            normalized_path = path.relative_to(resource_root).as_posix()
            if normalized_path in resource_paths:
                raise BenchmarkError("duplicate attachment path", location + ":attachments")
            resource_paths.add(normalized_path)
            content = path.read_bytes()
            if len(content) > 16 * 1024 * 1024:
                raise BenchmarkError("attachment exceeds 16 MiB", name)
            resources.append(
                {
                    "path": normalized_path,
                    "digest": bytes_digest(content),
                    "content_base64": base64.b64encode(content).decode("ascii"),
                }
            )
        family = row.get("family") or identifier
        if not isinstance(family, str):
            raise BenchmarkError("family must be a string", location + ":family")
        previous = families.setdefault(family, row["split"])
        if previous != row["split"]:
            raise BenchmarkError("family occurs in seed and held_out", location + ":family")
        input_identity = digest(
            {
                "instruction": row["instruction"],
                "resources": sorted(resources, key=lambda resource: resource["path"]),
            }
        )
        if inputs.setdefault(input_identity, row["split"]) != row["split"]:
            raise BenchmarkError(
                "identical input occurs in seed and held_out", location + ":instruction"
            )
        tags = row.get("tags") or []
        if isinstance(tags, str):
            tags = [tag.strip() for tag in tags.split(";") if tag.strip()]
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise BenchmarkError("tags must be a list of strings", location + ":tags")
        task = {
            "id": identifier,
            "instruction": row["instruction"],
            "family": family,
            "tags": tags,
            "resources": resources,
            "environment": "python:3.12-slim",
        }
        tasks.append({**task, "digest": digest(task)})
        verifier = {
            "expected": expected,
            "rule": rule,
            "fixtures": deepcopy(golden),
            **({"instruction": row["instruction"]} if template == "llm" else {}),
        }
        verifiers[identifier] = {**verifier, "digest": digest(verifier)}
        seen.add(identifier)
        splits[row["split"]].append(identifier)
    if set(config.get("fixtures", {})) - seen:
        raise BenchmarkError("fixtures contain unknown task IDs", "benchmark.yaml:fixtures")
    if not tasks or not splits["seed"]:
        raise BenchmarkError("benchmark requires seed tasks", source.name)
    body = {
        "version": 1,
        "tasks": tasks,
        "verifiers": verifiers,
        "splits": splits,
        "metric": {
            "name": "pass_rate",
            "unit": "ratio",
            "direction": "maximize",
            "range": [0, 1],
            "pass": 1,
            "task_aggregation": "mean",
            "repetition_aggregation": "mean",
            "missing": "invalid",
        },
        "source_digest": bytes_digest(source.read_bytes()),
        "execution_timeouts": {task["id"]: template_timeouts(rule) for task in tasks},
        "runtime_limits_source_digest": bytes_digest(source_bytes()),
        **(
            {
                "scorer_metadata": {
                    "kind": template,
                    **{key: value for key, value in rule["scorer"].items() if key != "source"},
                }
            }
            if template in ("python", "llm")
            else {}
        ),
        **({"split_digest": split_identity} if split_identity is not None else {}),
        **({"importer": config["importer"]} if "importer" in config else {}),
        "scorer_source_digest": bytes_digest(scorer_source_bytes()),
        **(
            {
                "python_scorer_source_digest": bytes_digest(
                    Path(__file__).with_name("python_scorer.py").read_bytes()
                )
            }
            if template == "python"
            else {}
        ),
        **(
            {
                "llm_scorer_source_digest": bytes_digest(
                    Path(__file__).with_name("llm_scorer.py").read_bytes()
                )
            }
            if template == "llm"
            else {}
        ),
        "checks": {
            "static": "passed",
            "verifier_fixtures": "not_run" if template in ("python", "llm") else "passed",
            "environment": "not_run",
        },
    }
    return {**body, "digest": digest(body)}


def bytes_digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def contained_file(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise BenchmarkError("resource path must be a normalized relative path", str(name))
    path = root / name
    if (
        Path(name).is_absolute()
        or ".." in Path(name).parts
        or path.is_symlink()
        or any(
            (root / Path(*Path(name).parts[:index])).is_symlink()
            for index in range(1, len(Path(name).parts))
        )
        or (path.exists() and path.stat().st_nlink != 1)
    ):
        raise BenchmarkError("resource must be an owned file inside the project", name)
    if not path.resolve().is_relative_to(root):
        raise BenchmarkError("resource must be an owned file inside the project", name)
    if not path.is_file():
        raise BenchmarkError("resource does not exist", name)
    return path


def contained_directory(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise BenchmarkError("directory must be a relative path", str(name))
    path = root / name
    if (
        Path(name).is_absolute()
        or ".." in Path(name).parts
        or any(
            (root / Path(*Path(name).parts[:index])).is_symlink()
            for index in range(1, len(Path(name).parts) + 1)
        )
        or not path.resolve().is_relative_to(root)
        or not path.is_dir()
    ):
        raise BenchmarkError("directory must be inside the project without links", name)
    return path
