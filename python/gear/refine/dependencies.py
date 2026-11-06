"""Bind declared installed dependencies to their version and actual installed bytes."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path

from gear.canonical import JSON, digest


def dependency_identity(name: str) -> dict[str, JSON]:
    distribution = importlib.metadata.distribution(name)
    files = distribution.files
    if not files:
        raise ValueError(f"dependency {name} has no installed file manifest")
    inventory: list[JSON] = []
    for item in sorted(files, key=str):
        # Bytecode and generated entrypoint scripts do not define imported code.
        if str(item).endswith(".pyc") or ".." in item.parts or "__pycache__" in item.parts:
            continue
        path = Path(distribution.locate_file(item))
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"dependency {name} contains missing files or symbolic links")
        if path.name == "direct_url.json" and json.loads(path.read_text()).get("dir_info", {}).get(
            "editable"
        ):
            raise ValueError(f"editable dependency {name} must be declared in source_dependencies")
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(block)
        inventory.append({"path": str(item), "digest": "sha256:" + hasher.hexdigest()})
    return {"name": name, "version": distribution.version, "content_digest": digest(inventory)}


def verify_dependencies(root: Path) -> None:
    path = root / "dependencies.json"
    if not path.exists():
        return
    recorded = json.loads(path.read_text())
    if not isinstance(recorded, list):
        raise ValueError("dependency manifest must be an array")
    for expected in recorded:
        if dependency_identity(expected["name"]) != expected:
            raise ValueError(f"frozen dependency changed: {expected['name']}")
