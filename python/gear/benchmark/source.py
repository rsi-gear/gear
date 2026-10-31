"""Read author rows with physical source locations; never infer a split while checking."""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path


class BenchmarkError(ValueError):
    def __init__(self, message: str, location: str):
        super().__init__(message)
        self.location = location


FIELDS = {"id", "instruction", "expected", "family", "split", "attachments", "tags"}


def json_value(text: str, location: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON field: " + key)
            result[key] = value
        return result

    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("non-finite JSON number: " + value)
        return parsed

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=number, parse_float=number)
    except ValueError as error:
        raise BenchmarkError(str(error), location) from error


def read_rows(source: Path) -> list[tuple[int, dict]]:
    try:
        if source.stat().st_size > 16 * 1024 * 1024:
            raise BenchmarkError("task source exceeds 16 MiB", source.name)
        if source.suffix.lower() == ".csv":
            with source.open(newline="", encoding="utf-8-sig") as stream:
                reader = csv.DictReader(stream, strict=True)
                fields = reader.fieldnames or []
                if set(fields) - FIELDS or len(set(fields)) != len(fields):
                    raise BenchmarkError("unknown or duplicate CSV field", source.name + ":1")
                if not {"id", "instruction", "expected"} <= set(fields):
                    raise BenchmarkError(
                        "CSV requires id, instruction and expected", source.name + ":1"
                    )
                result = []
                line = reader.line_num + 1
                for row in reader:
                    result.append((line, row))
                    line = reader.line_num + 1
                return result
        if source.suffix.lower() == ".jsonl":
            return [
                (line, json_value(text, f"{source.name}:{line}"))
                for line, text in enumerate(source.read_text(encoding="utf-8-sig").splitlines(), 1)
                if text.strip()
            ]
    except (OSError, UnicodeError, csv.Error) as error:
        raise BenchmarkError("unable to read task source: " + str(error), source.name) from error
    raise BenchmarkError("source must be CSV or JSONL", source.name)


def apply_splits(rows: list[tuple[int, dict]], manifest: object, location: str):
    if (
        not isinstance(manifest, dict)
        or set(manifest) - {"version", "seed", "held_out", "allocation"}
        or manifest.get("version") != 1
    ):
        raise BenchmarkError("unsupported split manifest", location)
    assignments = {}
    for split in ("seed", "held_out"):
        ids = manifest.get(split)
        if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
            raise BenchmarkError("split IDs must be string arrays", location + ":" + split)
        for identifier in ids:
            if identifier in assignments:
                raise BenchmarkError(
                    "duplicate ID or overlap between splits", location + ":" + identifier
                )
            assignments[identifier] = split
    identifiers = {
        row.get("id") for _, row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    if set(assignments) != identifiers:
        raise BenchmarkError("split manifest must cover exactly the current task IDs", location)
    result = []
    for line, row in rows:
        identifier = row.get("id") if isinstance(row, dict) else None
        if not isinstance(identifier, str) or identifier not in assignments:
            raise BenchmarkError("invalid task row", location)
        selected = assignments[identifier]
        if row.get("split") not in (None, "", selected):
            raise BenchmarkError(
                "task split conflicts with the saved manifest", location + ":" + identifier
            )
        result.append((line, {**row, "split": selected}))
    return result
