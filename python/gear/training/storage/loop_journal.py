"""Durable stage JSON records, separate from public training orchestration."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from enum import Enum
from pathlib import Path
from typing import TypeVar, cast

from gear.canonical import JSON

from .content import ContractError, require, sync_dir


class Missing(Enum):
    VALUE = 0


_MISSING = Missing.VALUE
T = TypeVar("T")


def _bytes(value: object) -> bytes:
    def validate(item: object) -> None:
        if item is None or type(item) in (str, bool, int, float):
            return
        if type(item) is list:
            for child in item:
                validate(child)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                validate(child)
            return
        raise ContractError(
            "non-json-stage-value",
            "configuration, checkpoints and stage results must be JSON values",
        )

    validate(value)
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (ValueError, OverflowError) as error:
        raise ContractError("non-json-stage-value", str(error)) from error


def _copy(value: T) -> T:
    return cast(T, json.loads(_bytes(value)))


def _digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(_bytes(value)).hexdigest()


def _write(path: str | Path, value: object) -> None:
    """Atomic, fsynced JSON, including ordinary Unicode application keys."""
    data = _bytes(value)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(
            os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
        ) as stream:
            stream.write(data + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read(path: str | Path) -> dict[str, JSON] | Missing:
    try:
        value = json.loads(
            Path(path).read_text(),
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
        require(
            isinstance(value, dict),
            "corrupt-training-artifact",
            str(path) + " must contain an object",
        )
        _bytes(value)
        return cast(dict[str, JSON], value)
    except FileNotFoundError:
        return _MISSING
    except ContractError:
        raise
    except (ValueError, UnicodeError) as error:
        raise ContractError("corrupt-training-artifact", str(path)) from error
