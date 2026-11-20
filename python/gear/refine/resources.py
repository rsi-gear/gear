"""Bind SDK-captured resource bytes to components, without reopening author paths."""

from __future__ import annotations

import base64
import hashlib
from typing import Any

from gear.canonical import digest
from gear.core.base import describe_module, entrypoint


def bind_resources(algorithm: object, resources: list[dict[str, Any]]) -> None:
    index = {}
    total = 0
    for item in resources:
        if set(item) != {"entrypoint", "name", "path", "digest", "content_base64"} or any(
            not isinstance(value, str) for value in item.values()
        ):
            raise ValueError("invalid frozen resource")
        raw = base64.b64decode(item["content_base64"], validate=True)
        total += len(raw)
        if len(raw) > 1024 * 1024 or total > 8 * 1024 * 1024 or len(resources) > 1024:
            raise ValueError("frozen resources exceed their bounds")
        if (
            "sha256:" + hashlib.sha256(raw).hexdigest() != item["digest"]
            or base64.b64encode(raw).decode() != item["content_base64"]
        ):
            raise ValueError("frozen resource digest or encoding mismatch")
        key = digest([item["entrypoint"], item["name"], item["path"]])
        if key in index:
            raise ValueError("duplicate frozen resource")
        index[key] = raw
    used = set()

    def bind(component: object) -> None:
        values = {}
        for name, path in getattr(component, "source_resources", ()):
            key = digest([entrypoint(component), name, path])
            if key not in index:
                raise ValueError("declared resource is missing from the frozen package")
            values[name] = index[key]
            used.add(key)
        if values:
            object.__setattr__(component, "_resource_values", values)

    describe_module(algorithm, on_component=bind)
    if used != set(index):
        raise ValueError("unclaimed resource in the frozen component package")
