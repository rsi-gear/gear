"""Frozen, offline Python pass/fail scorers. Execute only in the verifier environment."""

from __future__ import annotations

import ast
import hashlib
import random
import re
from copy import deepcopy
from pathlib import Path, PurePosixPath

from gear.canonical import JSON

from .scorers import Score


def artifact_path(name: object) -> bool:
    if not isinstance(name, str) or not name or len(name) > 256:
        return False
    path = PurePosixPath(name)
    return (
        name != "."
        and not path.is_absolute()
        and str(path) == name
        and ".." not in path.parts
        and "\\" not in name
        and "\0" not in name
    )


def freeze_python_scorer(root: Path, config: object) -> dict:
    """Parse and freeze one source file without importing or evaluating project code."""
    from .compiler import bytes_digest, contained_file
    from .source import BenchmarkError

    location = "benchmark.yaml:scorer"
    if not isinstance(config, dict) or set(config) != {
        "entrypoint",
        "version",
        "randomness",
        "cost",
        "artifacts",
    }:
        raise BenchmarkError(
            "Python scorer requires entrypoint, version, randomness, cost and artifacts", location
        )
    entrypoint = config["entrypoint"]
    if not isinstance(entrypoint, str) or not re.fullmatch(r"[^:]+\.py:[A-Za-z_]\w*", entrypoint):
        raise BenchmarkError("entrypoint must be file.py:function", location + ":entrypoint")
    filename, function = entrypoint.rsplit(":", 1)
    path = contained_file(root, filename)
    if path.relative_to(root).as_posix() != filename or path.stat().st_size > 1024 * 1024:
        raise BenchmarkError("scorer source must be normalized and at most 1 MiB", location)
    version = config["version"]
    if not isinstance(version, str) or not version.strip() or len(version) > 128:
        raise BenchmarkError("scorer version must be a nonempty string", location + ":version")
    randomness = config["randomness"]
    if (
        not isinstance(randomness, dict)
        or set(randomness) != {"seed"}
        or type(randomness["seed"]) is not int
        or not 0 <= randomness["seed"] < 2**32
    ):
        raise BenchmarkError(
            "randomness requires an unsigned 32-bit seed", location + ":randomness"
        )
    cost = config["cost"]
    if (
        not isinstance(cost, dict)
        or set(cost) != {"model_requests"}
        or type(cost["model_requests"]) is not int
        or cost["model_requests"] != 0
    ):
        raise BenchmarkError("Python scorers must declare zero model requests", location + ":cost")
    artifacts = config["artifacts"]
    if (
        not isinstance(artifacts, list)
        or len(artifacts) > 128
        or any(not artifact_path(name) or name == "answer.txt" for name in artifacts)
        or len(set(artifacts)) != len(artifacts)
    ):
        raise BenchmarkError(
            "artifacts must be unique contained paths other than answer.txt", location
        )
    data = path.read_bytes()
    try:
        source = data.decode("utf-8")
        tree = ast.parse(source, filename)
        compile(
            tree, filename, "exec"
        )  # Validate contexts (e.g. return outside a function), without execution.
    except SyntaxError as error:
        raise BenchmarkError(
            "scorer source is not valid Python", f"{filename}:{error.lineno or 1}"
        ) from error
    except UnicodeError as error:
        raise BenchmarkError("scorer source is not valid UTF-8 Python", filename) from error
    definitions = [
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == function
    ]
    if len(definitions) != 1:
        raise BenchmarkError("entrypoint must name one top-level synchronous function", filename)
    args = definitions[0].args
    if (
        [arg.arg for arg in args.posonlyargs + args.args] != ["actual", "expected", "artifacts"]
        or [arg.arg for arg in args.kwonlyargs] != ["seed"]
        or args.vararg
        or args.kwarg
        or args.defaults
        or args.kw_defaults != [None]
    ):
        raise BenchmarkError(
            "scorer signature must be (actual, expected, artifacts, *, seed)", filename
        )
    return {**deepcopy(config), "source": source, "source_digest": bytes_digest(data)}


def score_python(actual: str, expected: JSON, scorer: dict, artifacts: dict[str, str]) -> Score:
    """The caller must provide isolation and a time limit; never call during static checks."""
    source = scorer["source"]
    identity = "sha256:" + hashlib.sha256(source.encode("utf-8")).hexdigest()
    if identity != scorer["source_digest"]:
        raise ValueError("frozen scorer source digest mismatch")
    filename, function = scorer["entrypoint"].rsplit(":", 1)
    namespace = {"__name__": "gear_project_scorer", "__file__": filename}
    seed = scorer["randomness"]["seed"]
    random.seed(seed)
    exec(compile(source, filename, "exec"), namespace)
    passed = namespace[function](actual, expected, artifacts, seed=seed)
    if type(passed) is not bool:
        raise ValueError("Python scorer must return bool")
    return Score("valid", float(passed), "passed" if passed else "assertion failed")
