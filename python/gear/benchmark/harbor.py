"""Compile frozen authoring contracts into native Harbor tasks and private verifiers."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

from gear.canonical import digest

from .compiler import BenchmarkError, bytes_digest
from .manifest import restore_metadata, seal_harbor
from .payload import NativeMaterializer
from .payload import source_bytes as payload_source_bytes
from .runtime_limits import source_bytes, template_timeouts
from .scorers import source_bytes as scorer_source_bytes

VERIFIER = """import json, os, sys
from dataclasses import asdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from gear.benchmark.scorers import score_output

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/app")
logs = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/logs/verifier")
logs.mkdir(parents=True, exist_ok=True)
(logs / "reward.txt").unlink(missing_ok=True)
spec = json.loads(Path(__file__).with_name("expected.json").read_text())
def record_usage(usage):
    temporary = logs / "gear-usage.tmp"
    with temporary.open("w") as stream:
        json.dump(usage, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, logs / "gear-usage.json")
    descriptor = os.open(logs, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    # Harbor retains verifier stdout, including interrupted or failed requests.
    print("GEAR_SCORER_USAGE " + json.dumps(usage, allow_nan=False), flush=True)
def read_output(name):
    path = root / name
    if not path.exists():
        return None
    if any((root / Path(*Path(name).parts[:i])).is_symlink() for i in range(1, len(Path(name).parts) + 1)):
        return None
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        return None
    return path.read_bytes().decode("utf-8")
try:
    kind = spec["rule"]["kind"]
    paths = spec["expected"] if kind == "files" else spec["rule"]["scorer"]["artifacts"] if kind in ("python", "llm") else []
    artifacts = {name: value for name in paths if (value := read_output(name)) is not None}
    if sum(len(value.encode("utf-8")) for value in artifacts.values()) > 16 * 1024 * 1024:
        raise ValueError("output artifacts exceed 16 MiB")
    actual = read_output("answer.txt") or ""
    if kind == "llm":
        from gear.benchmark.llm_scorer import score_llm
        result = score_llm(actual, spec["expected"], spec["rule"]["scorer"], spec["instruction"], artifacts, record_usage)
    elif kind == "python":
        from gear.benchmark.python_scorer import score_python
        result = asdict(score_python(actual, spec["expected"], spec["rule"]["scorer"], artifacts))
    else:
        result = asdict(score_output(actual, spec["expected"], spec["rule"], artifacts))
except Exception as error:
    result = {"status": "scoring_failed", "value": None, "reason": type(error).__name__}
(logs / "gear-result.json").write_text(json.dumps(result))
if result["status"] != "valid":
    raise SystemExit(2)
(logs / "reward.txt").write_text(str(result["value"]))
"""


def compile_harbor(
    benchmark: dict,
    destination: str,
    task_ids: list[str],
    base_image: str,
    *,
    planning_only: bool = False,
) -> dict:
    """No imports from project code and no mutable source paths after admission."""
    if not isinstance(planning_only, bool):
        raise BenchmarkError("planning_only must be a boolean", "planning_only")
    body = {key: value for key, value in benchmark.items() if key != "digest"}
    if digest(body) != benchmark.get("digest"):
        raise BenchmarkError("frozen benchmark digest mismatch", "benchmark")
    if bytes_digest(source_bytes()) != benchmark.get("runtime_limits_source_digest"):
        raise BenchmarkError(
            "runtime limits implementation changed; use the admitted runtime", "runtime_limits"
        )
    scorer = Path(__file__).with_name("scorers.py")
    if bytes_digest(scorer_source_bytes()) != benchmark["scorer_source_digest"]:
        raise BenchmarkError("scorer implementation changed; use the admitted runtime", "scorer")
    python_scorer = Path(__file__).with_name("python_scorer.py")
    if any(verifier["rule"]["kind"] == "python" for verifier in benchmark["verifiers"].values()):
        if bytes_digest(python_scorer.read_bytes()) != benchmark.get("python_scorer_source_digest"):
            raise BenchmarkError(
                "Python scorer runtime changed; use the admitted runtime", "scorer"
            )
    llm_scorer = Path(__file__).with_name("llm_scorer.py")
    if any(verifier["rule"]["kind"] == "llm" for verifier in benchmark["verifiers"].values()):
        if bytes_digest(llm_scorer.read_bytes()) != benchmark.get("llm_scorer_source_digest"):
            raise BenchmarkError("LLM scorer runtime changed; use the admitted runtime", "scorer")
    if not re.fullmatch(r"[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}", base_image):
        raise BenchmarkError("Harbor requires a pinned OCI base image digest", "base_image")
    tasks = {task["id"]: task for task in benchmark["tasks"]}
    if not task_ids or len(set(task_ids)) != len(task_ids) or not set(task_ids) <= tasks.keys():
        raise BenchmarkError("expected a nonempty exact task subset", "task_ids")
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    environments = {}
    materializer = NativeMaterializer(benchmark.get("native_blobs", {}))
    for identifier in task_ids:
        task = tasks[identifier]
        verifier = benchmark["verifiers"][identifier]
        if verifier["rule"]["kind"] == "harbor":
            if bytes_digest(Path(__file__).with_name("native.py").read_bytes()) != benchmark.get(
                "native_source_digest"
            ):
                raise BenchmarkError(
                    "native importer changed; use the admitted runtime", "native_source_digest"
                )
            if bytes_digest(payload_source_bytes()) != benchmark.get("payload_source_digest"):
                raise BenchmarkError(
                    "native payload runtime changed; use the admitted runtime",
                    "payload_source_digest",
                )
            if bytes_digest(
                Path(__file__).with_name("environment.py").read_bytes()
            ) != benchmark.get("environment_source_digest"):
                raise BenchmarkError(
                    "native environment runtime changed; use the admitted runtime",
                    "environment_source_digest",
                )
            environments[identifier] = verifier["native_environment"]
            # Runtime platform/resource discovery consumes declarations only.
            # It must not materialize every task's build and verifier payload.
            planning_files = {
                "task.toml",
                *verifier["native_environment"]["dockerfiles"],
                *verifier["native_environment"]["compose"],
            }
            for name in [] if planning_only else verifier["native_directories"]:
                path = Path(name)
                if path.is_absolute() or ".." in path.parts or "\\" in name:
                    raise BenchmarkError("invalid frozen native directory", name)
                (root / identifier / path).mkdir(parents=True, exist_ok=True)
            for resource in verifier["native_files"]:
                if planning_only and resource["path"] not in planning_files:
                    continue
                path = Path(resource["path"])
                if path.is_absolute() or ".." in path.parts or "\\" in resource["path"]:
                    raise BenchmarkError("invalid frozen native path", resource["path"])
                output = root / identifier / path
                output.parent.mkdir(parents=True, exist_ok=True)
                materializer.write(resource, output)
            continue
        environments[identifier] = {
            "mains": {
                "environment": {"context": "environment", "dockerfile": "environment/Dockerfile"},
                "tests": {"context": "tests", "dockerfile": "tests/Dockerfile"},
            },
            "compose": [],
        }
        directory = root / identifier
        environment, tests = directory / "environment", directory / "tests"
        environment.mkdir(parents=True)
        tests.mkdir()
        instruction = task["instruction"]
        if verifier["rule"]["kind"] in ("text", "json", "python", "llm"):
            instruction += (
                "\n\nSave your final answer to /app/answer.txt. The verifier reads that file."
            )
            if (
                verifier["rule"]["kind"] in ("python", "llm")
                and verifier["rule"]["scorer"]["artifacts"]
            ):
                instruction += "\nThe verifier also reads these files under /app: " + ", ".join(
                    verifier["rule"]["scorer"]["artifacts"]
                )
        else:
            instruction += "\n\nCreate the requested files under /app."
        if not planning_only:
            (directory / "instruction.md").write_text(instruction + "\n", encoding="utf-8")
        llm = verifier["rule"]["kind"] == "llm"
        verifier_env = (
            (
                "[verifier.env]\n"
                + verifier["rule"]["scorer"]["api_key_env"]
                + ' = "${'
                + verifier["rule"]["scorer"]["api_key_env"]
                + '}"\n'
            )
            if llm
            else ""
        )
        network = "public" if llm else "no-network"
        limits = template_timeouts(verifier["rule"])
        if limits != benchmark["execution_timeouts"][identifier]:
            raise BenchmarkError("frozen execution deadlines changed", identifier)
        (directory / "task.toml").write_text(
            'version = "1.0"\nartifacts = ["/app"]\n[agent]\n'
            f"timeout_sec = {limits['agent_seconds']}\n"
            f'[verifier]\ntimeout_sec = {limits["verifier_seconds"]}\nenvironment_mode = "separate"\n'
            f"{verifier_env}"
            f"[verifier.environment]\nbuild_timeout_sec = {limits['verifier_build_seconds']}\n"
            "cpus = 1\nmemory_mb = 1024\n"
            f'storage_mb = 4096\nnetwork_mode = "{network}"\n'
            f"[environment]\nbuild_timeout_sec = {limits['environment_build_seconds']}\n"
            "cpus = 1\nmemory_mb = 2048\nstorage_mb = 4096\n",
            encoding="utf-8",
        )
        (environment / "inputs").mkdir()
        if planning_only:
            (environment / "Dockerfile").write_text(f"FROM {base_image}\n", encoding="utf-8")
            (tests / "Dockerfile").write_text(f"FROM {base_image}\n", encoding="utf-8")
            continue
        for resource in task["resources"]:
            path = Path(resource["path"])
            if path.is_absolute() or ".." in path.parts or "\\" in resource["path"]:
                raise BenchmarkError("invalid frozen resource path", resource["path"])
            content = base64.b64decode(resource["content_base64"], validate=True)
            if bytes_digest(content) != resource["digest"]:
                raise BenchmarkError("frozen resource digest mismatch", resource["path"])
            output = environment / "inputs" / path
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(content)
        (environment / "Dockerfile").write_text(
            f"FROM {base_image}\nWORKDIR /app\nCOPY inputs/ /app/\n", encoding="utf-8"
        )
        (tests / "expected.json").write_text(
            json.dumps(verifier, ensure_ascii=False), encoding="utf-8"
        )
        runtime = tests / "gear" / "benchmark"
        runtime.mkdir(parents=True)
        (runtime.parent / "__init__.py").write_text("")
        (runtime / "__init__.py").write_text("")
        (runtime / "scorers.py").write_bytes(scorer.read_bytes())
        (runtime / "source.py").write_bytes(scorer.with_name("source.py").read_bytes())
        if verifier["rule"]["kind"] == "python":
            (runtime / "python_scorer.py").write_bytes(python_scorer.read_bytes())
        if llm:
            (runtime / "llm_scorer.py").write_bytes(llm_scorer.read_bytes())
        (runtime.parent / "canonical.py").write_bytes(
            scorer.parent.parent.joinpath("canonical.py").read_bytes()
        )
        (tests / "verify.py").write_text(VERIFIER, encoding="utf-8")
        (tests / "test.sh").write_text(
            "#!/bin/sh\nset -eu\npython3 /tests/verify.py\n", encoding="utf-8"
        )
        (tests / "test.sh").chmod(0o755)
        (tests / "Dockerfile").write_text(
            f"FROM {base_image}\nCOPY . /tests\nWORKDIR /tests\n"
            'RUN mkdir -p /app /logs/verifier\nCMD ["sleep", "infinity"]\n',
            encoding="utf-8",
        )
    if not planning_only:
        restore_metadata(benchmark, root)
        seal_harbor(benchmark, destination, task_ids)
    return {
        "directory": str(root.resolve()),
        "environments": environments,
        "tasks": task_ids,
        "benchmark_digest": benchmark["digest"],
        "compiler_digest": bytes_digest(Path(__file__).read_bytes()),
        "base_image": base_image,
    }
