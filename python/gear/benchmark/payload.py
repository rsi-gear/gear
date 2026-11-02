"""Content-addressed import payloads, with separate transport and materialization limits."""

from __future__ import annotations

import base64
import errno
import hashlib
import os
import stat
import sys
from collections import OrderedDict
from pathlib import Path

from .limits import benchmark_limits
from .limits import source_bytes as limits_source_bytes
from .source import BenchmarkError


def source_bytes() -> bytes:
    return Path(__file__).read_bytes() + b"\0" + limits_source_bytes()


class Payload:
    def __init__(self):
        self.limits = benchmark_limits()
        self.blobs: dict[str, str] = {}
        self.unique_bytes = 0
        self.materialized_bytes = 0
        self.entries = 0

    def add(self, path: str, content: bytes, executable: bool = False) -> dict:
        self.materialized_bytes += len(content)
        self.entries += 1
        if (
            self.materialized_bytes > self.limits["maxMaterializedBytes"]
            or self.entries > self.limits["maxFiles"]
        ):
            raise BenchmarkError(
                "native payload exceeds maxMaterializedBytes or maxFiles in GEAR_BENCHMARK_LIMITS_JSON",
                path,
            )
        identity = "sha256:" + hashlib.sha256(content).hexdigest()
        if identity not in self.blobs:
            self.unique_bytes += len(content)
            if self.unique_bytes > self.limits["maxUniqueBytes"]:
                raise BenchmarkError(
                    "unique payload content exceeds maxUniqueBytes in GEAR_BENCHMARK_LIMITS_JSON",
                    path,
                )
            self.blobs[identity] = base64.b64encode(content).decode("ascii")
        return {"path": path, "digest": identity, "size": len(content), "executable": executable}

    def text(self, path: str, content: str) -> dict:
        return self.add(path, content.encode("utf-8"))


def content_bytes(file: dict, blobs: dict[str, str]) -> bytes:
    try:
        encoded = blobs[file["digest"]]
        content = base64.b64decode(encoded, validate=True)
        if (
            len(content) != file["size"]
            or base64.b64encode(content).decode("ascii") != encoded
            or "sha256:" + hashlib.sha256(content).hexdigest() != file["digest"]
        ):
            raise ValueError("content changed")
        return content
    except (KeyError, TypeError, ValueError) as error:
        raise BenchmarkError(
            "frozen native resource digest or size mismatch", file.get("path")
        ) from error


def used_blobs(files: list[dict], blobs: dict[str, str]) -> dict[str, str]:
    """Exclude replaced source bytes from the executable payload identity."""
    return {identity: blobs[identity] for identity in sorted({file["digest"] for file in files})}


class NativeMaterializer:
    """One compilation's bounded decoded blobs and independent file clones.

    No paths or successful verdicts survive the call. Copy-on-write is optional;
    unsupported filesystems keep independent ordinary files, never hardlinks.
    """

    def __init__(self, blobs: dict[str, str], cache_bytes: int = 32 * 1024**2):
        self.blobs = blobs
        self.cache_bytes = cache_bytes
        self.cached_bytes = 0
        self.decoded: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
        self.sources: dict[str, Path] = {}
        self.clone_available = sys.platform == "linux"

    def content(self, file: dict) -> bytes:
        identity = file["digest"]
        cached = self.decoded.get(identity)
        if cached is not None and cached[0] == self.blobs.get(identity):
            if len(cached[1]) != file["size"]:
                raise BenchmarkError("frozen native resource size mismatch", file.get("path"))
            self.decoded.move_to_end(identity)
            return cached[1]
        data = content_bytes(file, self.blobs)
        if len(data) <= self.cache_bytes:
            if cached is not None:
                self.cached_bytes -= len(self.decoded.pop(identity)[1])
            while self.cached_bytes + len(data) > self.cache_bytes:
                self.cached_bytes -= len(self.decoded.popitem(last=False)[1][1])
            self.decoded[identity] = (self.blobs[identity], data)
            self.cached_bytes += len(data)
        return data

    def write(self, file: dict, output: Path) -> None:
        data = self.content(file)
        source = self.sources.get(file["digest"])
        with output.open("xb") as target:
            cloned = False
            if source is not None and self.clone_available:
                import fcntl

                descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                        raise BenchmarkError(
                            "native clone source is not a regular file", file["path"]
                        )
                    try:
                        fcntl.ioctl(target.fileno(), 0x40049409, descriptor)  # Linux FICLONE
                        cloned = True
                    except OSError as error:
                        if error.errno not in (errno.EXDEV, errno.EOPNOTSUPP, errno.ENOTTY):
                            raise
                        self.clone_available = False
                        target.truncate(0)
                finally:
                    os.close(descriptor)
            if not cloned:
                target.write(data)
        if cloned:
            # The earlier output is private but writable. Verify the clone,
            # including its length, before admitting it as frozen task input.
            if (
                output.stat().st_size != len(data)
                or "sha256:" + hashlib.sha256(output.read_bytes()).hexdigest() != file["digest"]
            ):
                raise BenchmarkError("cloned native resource changed", file["path"])
        output.chmod(0o755 if file["executable"] else 0o644)
        self.sources.setdefault(file["digest"], output)
