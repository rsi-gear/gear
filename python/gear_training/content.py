"""Byte-addressed immutable objects shared with the TypeScript coordinator."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import uuid
from pathlib import Path
from urllib.parse import urlparse, unquote


class ContractError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

    def __reduce__(self):
        return ContractError, (self.code, str(self))


def require(ok, code, message):
    if not ok:
        raise ContractError(code, message)


def digest_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def canonical(value):
    """ECMAScript-compatible JSON numbers for cross-language manifest identities.

    Contract keys are ASCII. Token/logprob blobs are byte-hashed, so consumers
    never need to reserialize them to establish generation identity.
    """
    if value is None or isinstance(value, (str, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        require(math.isfinite(value), "non-finite-json", "JSON numbers must be finite")
        if value == 0:
            return "0"
        if isinstance(value, int):
            require(abs(value) <= 9007199254740991, "unsafe-json-integer", "integer exceeds JS safe range")
            return str(value)
        # Python and ECMAScript use shortest round-trip decimal representations;
        # the only formatting difference here is their exponent threshold.
        raw = repr(value).lower()
        from decimal import Decimal
        if 1e-6 <= abs(value) < 1e21:
            return format(Decimal(raw), "f").rstrip("0").rstrip(".") if "." in format(Decimal(raw), "f") else format(Decimal(raw), "f")
        mantissa, exponent = raw.split("e") if "e" in raw else (raw, "0")
        if mantissa.endswith(".0"):
            mantissa = mantissa[:-2]
        e = int(exponent)
        return mantissa + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    if isinstance(value, list):
        return "[" + ",".join(canonical(x) for x in value) + "]"
    require(isinstance(value, dict), "invalid-json", "expected JSON value")
    require(all(isinstance(k, str) and k.isascii() for k in value), "invalid-contract-key", "contract object keys must be ASCII")
    return "{" + ",".join(canonical(k) + ":" + canonical(value[k]) for k in sorted(value)) + "}"


def digest_json(value):
    return digest_bytes(canonical(value).encode("utf-8"))


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as f:
            f.write(canonical(value) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


class ContentStore:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def path(self, digest):
        require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest), "invalid-digest", "expected sha256 content digest")
        return self.root / "objects" / digest[7:9] / digest[7:]

    def put_bytes(self, data, media_type):
        digest = digest_bytes(data)
        path = self.path(digest)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(tmp, path)
            except FileExistsError:
                pass
            require(digest_bytes(path.read_bytes()) == digest, "corrupt-content", "immutable object is corrupt")
            sync_dir(path.parent)
        finally:
            tmp.unlink(missing_ok=True)
        return {"uri": "cas:" + digest, "digest": digest, "mediaType": media_type}

    def put_file(self, source, media_type="application/octet-stream"):
        source = Path(source)
        digest = digest_file(source)
        path = self.path(digest)
        ref = {"uri": "cas:" + digest, "digest": digest, "mediaType": media_type}
        # Save/export recovery reseals the same large checkpoint. Reuse only
        # verified immutable bytes, without another checkpoint-sized temp copy.
        try: existing = digest_file(path)
        except FileNotFoundError: pass
        else:
            require(existing == digest, "corrupt-content", "immutable object is corrupt")
            return ref
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with source.open("rb") as incoming, tmp.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, 8 * 1024 * 1024)
                outgoing.flush(); os.fsync(outgoing.fileno())
            require(digest_file(tmp) == digest, "source-changed", "source changed during CAS import")
            try: os.link(tmp, path)
            except FileExistsError: pass
            require(digest_file(path) == digest, "corrupt-content", "immutable object is corrupt")
            sync_dir(path.parent)
        finally:
            tmp.unlink(missing_ok=True)
        return ref

    def copy_ref(self, ref, destination):
        # File manifests always use CAS refs, so they remain portable to workers.
        require(ref["uri"] == "cas:" + ref["digest"], "nonportable-file-ref", "snapshot files must be in CAS")
        with self.path(ref["digest"]).open("rb") as source, Path(destination).open("xb") as target:
            shutil.copyfileobj(source, target, 8 * 1024 * 1024)
            target.flush(); os.fsync(target.fileno())
        require(digest_file(destination) == ref["digest"], "content-digest-mismatch", "referenced content changed")

    def put_json(self, value):
        return self.put_bytes(canonical(value).encode("utf-8"), "application/json")

    def read_bytes(self, ref):
        require(isinstance(ref, dict) and set(ref) == {"uri", "digest", "mediaType"}, "invalid-ref", "invalid ContentRef")
        path = self.path(ref["digest"])
        if ref["uri"] != "cas:" + ref["digest"]:
            uri = urlparse(ref["uri"])
            require(uri.scheme == "file" and uri.netloc in ("", "localhost"), "invalid-content-uri", "only CAS and local file refs are supported")
            path = Path(unquote(uri.path))
        data = path.read_bytes()
        require(digest_bytes(data) == ref["digest"], "content-digest-mismatch", "referenced content changed")
        return data

    def read_json(self, ref):
        require(ref.get("mediaType") == "application/json", "invalid-media-type", "expected JSON content")
        return json.loads(self.read_bytes(ref), parse_constant=lambda x: (_ for _ in ()).throw(ContractError("non-finite-json", x)))
