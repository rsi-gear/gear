"""Implementation identity covers the actual frozen UTF-8 source and resources."""

import hashlib
from pathlib import Path

from gear.canonical import digest


def source_identity(root: Path) -> str:
    files = []
    for path in sorted(root.rglob("*")):
        if "__pycache__" in path.parts:
            continue
        if path.is_symlink():
            raise ValueError("frozen algorithm source cannot contain links")
        if path.is_file():
            files.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
    return digest(files)
