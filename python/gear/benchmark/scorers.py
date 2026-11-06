"""Deterministic verifier rules. Expected values never belong in Target input."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from gear.canonical import JSON

from .source import json_value


def source_bytes() -> bytes:
    """Bind both scoring rules and the strict decoder copied into the verifier."""
    return Path(__file__).read_bytes() + b"\0" + Path(__file__).with_name("source.py").read_bytes()


@dataclass(frozen=True)
class Score:
    status: Literal["valid", "scoring_failed"]
    value: float | None
    reason: str


def normalized(value: str, rules: dict) -> str:
    if rules.get("trim", False):
        value = value.strip()
    if rules.get("collapse_whitespace", False):
        value = " ".join(value.split())
    if rules.get("casefold", False):
        value = value.casefold()
    return value


def score_output(
    actual: str, expected: JSON, rule: dict, artifacts: dict[str, str] | None = None
) -> Score:
    kind = rule["kind"]
    if kind == "text":
        if not isinstance(expected, str):
            raise ValueError("text expected value must be a string")
        passed = normalized(actual, rule) == normalized(expected, rule)
    elif kind == "json":
        try:
            parsed = json_value(actual, "output")
        except (ValueError, TypeError):
            return Score("valid", 0.0, "output is not valid JSON")
        if not isinstance(expected, dict):
            raise ValueError("JSON assertions must be an object")
        passed = all(
            json_assertion(parsed, pointer, wanted) for pointer, wanted in expected.items()
        )
    elif kind == "files":
        if not isinstance(expected, dict):
            raise ValueError("file rules must be a path/assertion map")
        passed = True
        for name, assertion in expected.items():
            path = PurePosixPath(name)
            if path.is_absolute() or str(path) != name or ".." in path.parts or "\\" in name:
                raise ValueError("file assertion path must be contained and normalized")
            content = (artifacts or {}).get(name)
            if assertion is None:
                passed = passed and content is not None
            elif isinstance(assertion, str):
                passed = passed and content == assertion
            elif isinstance(assertion, dict):
                result = score_output(content or "", assertion, {"kind": "json"})
                passed = passed and content is not None and result.value == 1
            else:
                raise ValueError("file assertion must be null, text or JSON fields")
    else:
        raise ValueError("unsupported deterministic scorer: " + str(kind))
    return Score("valid", float(passed), "passed" if passed else "assertion failed")


def json_assertion(actual: JSON, pointer: str, expected: JSON) -> bool:
    if pointer != "" and not pointer.startswith("/"):
        raise ValueError("JSON assertions use RFC 6901 pointers")
    if re.search(r"~(?![01])", pointer):
        raise ValueError("JSON pointer contains an invalid escape")
    current = actual
    try:
        for token in [] if not pointer else pointer[1:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if isinstance(current, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", token):
                    return False
                current = current[int(token)]
            else:
                current = current[token]
    except (KeyError, IndexError, TypeError, ValueError):
        return False
    # bool and number are distinct JSON types; do not allow True == 1.
    return json_equal(current, expected)


def json_equal(left: JSON, right: JSON) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            json_equal(left[key], right[key]) for key in left
        )
    return left == right


def fixtures(expected: JSON, rule: dict) -> list[dict]:
    if rule["kind"] == "text":
        return [
            {"actual": expected, "score": 1},
            {"actual": str(expected) + "\nINCORRECT", "score": 0},
        ]
    if rule["kind"] == "files":
        positive = {
            name: ""
            if value is None
            else value
            if isinstance(value, str)
            else json.dumps(_from_assertions(value))
            for name, value in expected.items()
        }
        return [
            {"actual": "", "artifacts": positive, "score": 1},
            {"actual": "", "artifacts": {}, "score": 0},
        ]
    if rule["kind"] == "json":
        positive = _from_assertions(expected)
        return [
            {"actual": json.dumps(positive), "score": 1},
            {"actual": "false" if positive is None else "null", "score": 0},
        ]
    raise ValueError("advanced scorers need explicit fixtures")


def _from_assertions(expected: dict) -> JSON:
    if "" in expected:
        if len(expected) != 1:
            raise ValueError("root assertion cannot be mixed with field assertions")
        return expected[""]
    result: dict = {}
    for pointer, value in expected.items():
        if not pointer.startswith("/") or "/" in pointer[1:]:
            raise ValueError("nested JSON pointer rules require explicit fixtures")
        result[pointer[1:].replace("~1", "/").replace("~0", "~")] = value
    return result
