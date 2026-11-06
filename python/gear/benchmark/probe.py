"""Prepare private verifier fixtures and interpret their container outputs; no model calls."""

from __future__ import annotations

import json
import math
from pathlib import Path, PurePosixPath

from .compiler import bytes_digest, contained_file
from .harbor import compile_harbor
from .source import BenchmarkError, json_value


def prepare_probe(
    benchmark: dict, destination: str, task_id: str, base_image: str, scorer: bool = False
) -> dict:
    if task_id not in benchmark["splits"]["seed"]:
        raise BenchmarkError("authoring probes require a seed task", "task_id")
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    compiled = compile_harbor(benchmark, str(root / "tasks"), [task_id], base_image)
    verifier = benchmark["verifiers"][task_id]
    layout = compiled["environments"][task_id]
    main = layout["mains"]["environment"]
    compose = None
    if "environment/docker-compose.yaml" in layout["compose"]:
        source = root / "tasks" / task_id / "environment/docker-compose.yaml"
        composition = json_value(source.read_text(), str(source))
        for name, service in composition["services"].items():
            if "build" in service:
                service["build"]["context"] = str(
                    (source.parent / service["build"]["context"]).resolve()
                )
            if name == "main":
                service.setdefault("command", ["sh", "-c", "sleep infinity"])
        path = root / "compose-probe.json"
        path.write_text(json.dumps(composition))
        compose = {"file": str(path.resolve()), "services": sorted(composition["services"])}
    cases = []
    for index, fixture in enumerate(verifier["fixtures"] if scorer else []):
        workspace = root / "fixtures" / str(index) / "workspace"
        logs = workspace.parent / "logs"
        workspace.mkdir(parents=True)
        logs.mkdir()
        logs.chmod(0o777)  # Native images may use a non-root verifier user.
        artifacts = (
            fixture.get("artifacts", {})
            if verifier["rule"]["kind"] == "files"
            else {**fixture.get("artifacts", {}), "answer.txt": fixture["actual"]}
        )
        total = 0
        if not isinstance(artifacts, dict):
            raise BenchmarkError("fixture artifacts must be a path/text map", "fixtures")
        for name, content in artifacts.items():
            path = PurePosixPath(name)
            if (
                not name
                or path.is_absolute()
                or str(path) != name
                or ".." in path.parts
                or "\\" in name
                or "\0" in name
                or not isinstance(content, str)
            ):
                raise BenchmarkError("fixture artifacts need contained paths and text", "fixtures")
            total += len(content.encode("utf-8"))
            if total > 16 * 1024 * 1024:
                raise BenchmarkError("fixture output exceeds 16 MiB", "fixtures")
            output = workspace / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8")
        cases.append(
            {
                "index": index,
                "workspace": str(workspace),
                "logs": str(logs),
                "expected_score": fixture["score"],
            }
        )
    return {
        "task_id": task_id,
        "benchmark_digest": benchmark["digest"],
        "compiler_digest": compiled["compiler_digest"],
        "probe_digest": bytes_digest(Path(__file__).read_bytes()),
        "scorer_digest": verifier["digest"],
        "scorer_metadata": (
            {key: value for key, value in verifier["rule"]["scorer"].items() if key != "source"}
            if verifier["rule"]["kind"] in ("python", "llm")
            else {"kind": verifier["rule"]["kind"]}
        ),
        "environment": str(root / "tasks" / task_id / main["context"]),
        "dockerfile": str(root / "tasks" / task_id / main["dockerfile"]),
        **({"compose": compose} if compose else {}),
        "tests": str(root / "tasks" / task_id / "tests"),
        "cases": cases,
        "scorer_requested": scorer,
        "usage_required": verifier["rule"]["kind"] == "llm" and scorer,
        "credential_env": (
            [verifier["rule"]["scorer"]["api_key_env"]]
            if verifier["rule"]["kind"] == "llm" and scorer
            else []
        ),
        "verifier_timeout_ms": (
            (verifier["rule"]["scorer"]["limits"]["timeout_seconds"] + 15) * 1000
            if verifier["rule"]["kind"] == "llm"
            else 60000
        ),
        "scorer_not_run_reason": (
            "native verifier has no declared positive/negative fixtures"
            if scorer and not cases
            else "scorer probe was not requested"
            if not scorer
            else None
        ),
    }


def read_probe_case(directory: str, expected_score: float, usage_required: bool = False) -> dict:
    root = Path(directory).resolve()
    usage = read_probe_usage(root) if usage_required else None
    try:

        def text(name):
            path = contained_file(root, name)
            if path.stat().st_size > 65536:
                raise ValueError("oversized verifier result")
            return path.read_text(encoding="utf-8")

        result = json_value(text("gear-result.json"), "gear-result.json")
        reward = float(text("reward.txt").strip())
        value = result.get("value")
        if (
            result.get("status") != "valid"
            or type(value) not in (int, float)
            or not 0 <= value <= 1
            or not math.isfinite(value)
            or not math.isfinite(reward)
            or value != reward
        ):
            raise ValueError("invalid verifier result")
        return {
            "status": "passed" if value == expected_score else "failed",
            "expected_score": expected_score,
            "observed_score": value,
            **({"usage": usage} if usage_required else {}),
        }
    except (OSError, ValueError, TypeError, AttributeError):
        return {
            "status": "scoring_failed",
            "reason": "missing or invalid verifier result",
            **({"usage": usage} if usage_required else {}),
        }


def read_probe_usage(root: Path) -> dict:
    unknown = {
        key: None
        for key in ("request_attempts", "model_requests", "tokens", "dollars", "estimated_dollars")
    }
    try:
        path = contained_file(root, "gear-usage.json")
        if path.stat().st_size > 65536:
            return unknown
        usage = json_value(path.read_text(encoding="utf-8"), "gear-usage.json")
        if not isinstance(usage, dict):
            return unknown
        for key in (
            "request_attempts",
            "model_requests",
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "tokens",
        ):
            value = usage[key]
            if value is not None and (type(value) is not int or not 0 <= value < 2**53):
                return unknown
        for key in ("dollars", "estimated_dollars"):
            value = usage[key]
            if value is not None and (
                type(value) not in (int, float) or not math.isfinite(value) or value < 0
            ):
                return unknown
        return usage
    except (OSError, ValueError, KeyError, TypeError):
        return unknown
