"""Stage identity includes actual source bytes and explicitly declared dependencies."""

from __future__ import annotations

import hashlib
import importlib.metadata
import inspect
from pathlib import Path

from gear.canonical import JSON
from gear.training.storage.content import ContractError, require


def stage_identity(stage: object) -> dict[str, JSON]:
    cls = type(stage)
    identifier = getattr(stage, "stage_id", cls.__module__ + "." + cls.__qualname__)
    require(
        isinstance(identifier, str) and bool(identifier),
        "invalid-stage-identity",
        "stage_id must be nonempty",
    )
    source = inspect.getsourcefile(cls)
    if source is None or not Path(source).is_file():
        raise ContractError(
            "stage-source-unavailable",
            "stage implementations require inspectable frozen Python source",
        )
    files = [
        Path(source),
        *(Path(path) for path in getattr(stage, "source_dependencies", ())),
    ]
    packages = getattr(stage, "package_dependencies", ())
    return {
        "id": identifier,
        "module": cls.__module__,
        "qualified_name": cls.__qualname__,
        "sources": [
            {
                "name": path.name,
                "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in files
        ],
        "packages": {name: importlib.metadata.version(name) for name in sorted(packages)},
    }
