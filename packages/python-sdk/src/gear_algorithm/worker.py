"""Trusted local Gear worker. Wire traffic uses loopback TCP, never stdio."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import sys
import traceback
from typing import Any

from .errors import GearAlgorithmError, ProtocolError, ValidationError
from .manifest import AlgorithmManifest, ProviderManifest
from .protocol import decision_to_wire, validate_json
from .provider import ArtifactClient
from .author import replay as replay_author

MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_AUTHOR_FRAME_BYTES = 1024 * 1024


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    while length:
        chunk = sock.recv(length)
        if not chunk:
            raise EOFError("Gear host disconnected")
        chunks.append(chunk)
        length -= len(chunk)
    return b"".join(chunks)


def read_frame(sock: socket.socket, max_bytes: int = MAX_FRAME_BYTES) -> dict[str, Any]:
    length = struct.unpack(">I", _read_exact(sock, 4))[0]
    if length == 0 or length > max_bytes:
        raise ProtocolError("invalid or oversized frame")
    try:
        value = json.loads(_read_exact(sock, length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid JSON frame") from exc
    validate_json(value)
    if not isinstance(value, dict):
        raise ProtocolError("frame must be an object")
    return value


def write_frame(sock: socket.socket, value: dict[str, Any], max_bytes: int = MAX_FRAME_BYTES) -> None:
    validate_json(value)
    data = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) == 0 or len(data) > max_bytes:
        raise ProtocolError("outgoing frame exceeds size limit")
    sock.sendall(struct.pack(">I", len(data)) + data)


def _load_export(module_name: str, export: str, config_dir: Path) -> tuple[Any, Path | None]:
    if not export.isidentifier() or export.startswith("_"):
        raise ValidationError("export must be a public Python identifier")
    sys.path.insert(0, str(config_dir))
    if module_name.endswith(".py") or "/" in module_name or "\\" in module_name:
        path = Path(module_name)
        if not path.is_absolute():
            path = config_dir / path
        path = path.resolve(strict=True)
        if path.suffix != ".py" or not path.is_file():
            raise ValidationError("module path must resolve to a .py file")
        unique = "gear_user_" + hashlib.sha256(str(path).encode()).hexdigest()[:16]
        spec = importlib.util.spec_from_file_location(unique, path)
        if spec is None or spec.loader is None:
            raise ValidationError("cannot load Python module", str(path))
        module = importlib.util.module_from_spec(spec)
        sys.modules[unique] = module
        spec.loader.exec_module(module)
    else:
        if not all(part.isidentifier() and not part.startswith("_") for part in module_name.split(".")):
            raise ValidationError("module must be a dotted import or .py file path")
        module = importlib.import_module(module_name)
        path = Path(module.__file__).resolve() if getattr(module, "__file__", None) else None
    if not hasattr(module, export):
        raise ValidationError(f"module has no export {export}")
    return getattr(module, export), path


def _describe_export(target: Any) -> dict[str, Any]:
    if not hasattr(target, "describe"):
        raise ValidationError("export requires describe()")
    result = target.describe()
    if isinstance(result, (AlgorithmManifest, ProviderManifest)):
        result = result.to_wire()
    validate_json(result)
    if not isinstance(result, dict):
        raise ValidationError("describe() must return a JSON object")
    return result


def _environment_info(source: Path | None) -> dict[str, Any]:
    packages = sorted((dist.metadata.get("Name", "").lower(), dist.version)
                      for dist in importlib.metadata.distributions())
    source_bytes = source.read_bytes() if source is not None else b""
    loaded_modules = []
    for name, imported in sys.modules.copy().items():
        filename = getattr(imported, "__file__", None)
        if not filename:
            continue
        path = Path(filename)
        if path.suffix == ".pyc" and path.with_suffix(".py").exists():
            path = path.with_suffix(".py")
        if not path.is_file():
            continue
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            continue
        loaded_modules.append([name, str(path.resolve()), digest])
    loaded_modules.sort()
    try:
        import fcntl  # noqa: F401 - capability probe for the local durable host
        fcntl_available = True
    except ImportError:
        fcntl_available = False
    return {"interpreter": str(Path(sys.executable).resolve()), "pythonVersion": sys.version,
            "fcntlAvailable": fcntl_available,
            "sourcePath": str(source) if source is not None else None,
            "sourceSha256": hashlib.sha256(source_bytes).hexdigest() if source is not None else None,
            "packages": [[name, version] for name, version in packages], "loadedModules": loaded_modules}


def _error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, GearAlgorithmError):
        return {"code": exc.code, "message": str(exc), "path": exc.path}
    # Arbitrary exception text can contain a secret or user data. Keep only
    # exception type and source location; never serialize locals or traceback.
    frames = traceback.extract_tb(exc.__traceback__)
    location = f" at {Path(frames[-1].filename).name}:{frames[-1].lineno}" if frames else ""
    return {"code": "PYTHON_ERROR", "message": f"{type(exc).__name__}{location}"}


def _dispatch(target: Any, mode: str, method: str, params: Any) -> Any:
    if method == "describe":
        return _describe_export(target)
    if method == "environment.describe":
        raise ProtocolError("environment.describe is handled by worker")
    if mode == "algorithm":
        if method not in ("algorithm.initialize", "algorithm.reduce"):
            raise ProtocolError(f"unsupported algorithm method {method}")
        function = target.initialize if method.endswith("initialize") else target.reduce
        return decision_to_wire(function(params))
    if mode == "author":
        if method != "author.replay":
            raise ProtocolError(f"unsupported author method {method}")
        return replay_author(target, params)
    if mode == "component":
        if method != "component.invoke":
            raise ProtocolError(f"unsupported component method {method}")
        if not hasattr(target, "invoke"):
            raise ValidationError("component export requires invoke(input)")
        return target.invoke(params)
    if mode == "provider":
        name = method.removeprefix("provider.")
        if name not in ("preflight", "submit", "inspect", "cancel", "collect") or method != f"provider.{name}":
            raise ProtocolError(f"unsupported provider method {method}")
        return getattr(target, name)(params)
    raise ProtocolError("invalid worker mode")


def run_worker(port: int, module: str, export: str, config_dir: Path, mode: str) -> None:
    token = os.environ.pop("GEAR_ALGORITHM_TOKEN", "")
    worker_id = os.environ.pop("GEAR_ALGORITHM_WORKER_ID", "")
    if not token or not worker_id or len(token) < 32:
        raise ProtocolError("worker launch credentials missing")
    try:
        target, source = _load_export(module, export, config_dir.resolve())
        startup_error = None
    except Exception as exc:
        target, source, startup_error = None, None, exc
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    sock.settimeout(None)
    try:
        write_frame(sock, {"type": "hello", "version": 1, "token": token, "workerId": worker_id})
        ack = read_frame(sock)
        if ack != {"type": "hello-ack", "version": 1, "workerId": worker_id}:
            raise ProtocolError("host rejected worker handshake")
        artifact_counter = 0
        def artifact_call(method: str, params: dict[str, Any]) -> Any:
            nonlocal artifact_counter
            artifact_counter += 1
            request_id = f"artifact:{worker_id}:{artifact_counter}"
            write_frame(sock, {"type": "request", "id": request_id, "method": method, "params": params})
            response = read_frame(sock)
            if response.get("type") != "response" or response.get("id") != request_id:
                raise ProtocolError("artifact response ID mismatch")
            if "error" in response:
                error = response["error"]
                raise ProtocolError(str(error.get("message", "artifact bridge failed")))
            return response.get("result")
        if hasattr(target, "bind_artifacts"):
            target.bind_artifacts(ArtifactClient(artifact_call))
        while True:
            frame = read_frame(sock, MAX_AUTHOR_FRAME_BYTES if mode == "author" else MAX_FRAME_BYTES)
            if frame.get("type") != "request" or not isinstance(frame.get("id"), str) or not frame["id"]:
                raise ProtocolError("invalid request envelope")
            method = frame.get("method")
            if not isinstance(method, str):
                raise ProtocolError("request method missing")
            try:
                if startup_error is not None:
                    if isinstance(startup_error, ModuleNotFoundError):
                        raise GearAlgorithmError("MISSING_DEPENDENCY", f"Missing Python dependency {startup_error.name or '<unknown>'}") from startup_error
                    if isinstance(startup_error, GearAlgorithmError):
                        raise startup_error
                    raise GearAlgorithmError("IMPORT_ERROR", f"{type(startup_error).__name__} while loading Python export") from startup_error
                result = _environment_info(source) if method == "environment.describe" else _dispatch(target, mode, method, frame.get("params"))
                validate_json(result)
                write_frame(sock, {"type": "response", "id": frame["id"], "result": result},
                            MAX_AUTHOR_FRAME_BYTES if mode == "author" else MAX_FRAME_BYTES)
            except Exception as exc:
                write_frame(sock, {"type": "response", "id": frame["id"], "error": _error(exc)},
                            MAX_AUTHOR_FRAME_BYTES if mode == "author" else MAX_FRAME_BYTES)
    except EOFError:
        pass
    finally:
        sock.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--module", required=True)
    parser.add_argument("--export", required=True)
    parser.add_argument("--config-dir", required=True)
    parser.add_argument("--mode", choices=("algorithm", "author", "component", "provider"), required=True)
    args = parser.parse_args()
    try:
        run_worker(args.port, args.module, args.export, Path(args.config_dir), args.mode)
    except Exception as exc:
        print(f"gear worker failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
