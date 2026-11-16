"""Versioned stdio algorithm worker. The parent runtime must provide an OS sandbox."""

from __future__ import annotations

import importlib
import inspect
import json
import sys
from contextlib import redirect_stdout
from dataclasses import asdict
from pathlib import Path

from gear.algorithms import GEPA, RandomSearch
from gear.canonical import digest
from gear.search.contracts_v1 import (
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    SearchView,
    Task,
)

from .dependencies import verify_dependencies
from .identity import source_identity
from .protocol import MAX_MESSAGE_BYTES, validate


def load_entrypoint(name: str):
    module, separator, member = name.partition(":")
    if not separator or not module or not member or member.startswith("_"):
        raise ValueError("entrypoint must be module:public_name")
    value = importlib.import_module(module)
    for part in member.split("."):
        if not part.isidentifier() or part.startswith("_"):
            raise ValueError("entrypoint members must be public Python identifiers")
        value = getattr(value, part)
    return value


def _freeze_configuration(algorithm):
    from gear.core.base import describe_module

    def freeze(component):
        if hasattr(component, "set_params"):
            object.__setattr__(component, "_configuration_frozen", True)

    describe_module(algorithm, on_component=freeze)
    return algorithm


def make_algorithm(config):
    if "component" in config:
        from gear.core.base import construct_module

        if config.get("options") or config["name"] != config["component"].get("entrypoint"):
            raise ValueError("component algorithm must have matching name and no legacy options")
        return _freeze_configuration(construct_module(config["component"], load_entrypoint))
    options = dict(config.get("options", {}))
    for key in ("parent_policy", "sampler", "proposal_planner", "ranker", "stop_rule"):
        if key in options:
            value = options[key]
            if isinstance(value, str):
                options[key] = load_entrypoint(value)
            elif isinstance(value, dict) and set(value) == {"component"}:
                from gear.core.base import construct_module
                options[key] = construct_module(value["component"], load_entrypoint)
            elif (
                isinstance(value, dict)
                and set(value) == {"entrypoint", "configuration"}
                and isinstance(value["configuration"], dict)
            ):
                options[key] = load_entrypoint(value["entrypoint"])(**value["configuration"])
            else:
                raise ValueError("policy requires an entrypoint or a configured entrypoint object")
    if config["name"] == "gepa":
        return _freeze_configuration(GEPA(**options))
    if config["name"] == "random-search":
        return _freeze_configuration(RandomSearch(**options))
    return load_entrypoint(config["name"])(**options)


def decode_view(value) -> SearchView:
    validate("SearchView", value)
    return SearchView(
        value["run_id"],
        value["step_id"],
        value["seed"],
        tuple(Task(**item) for item in value["tasks"]),
        tuple(Candidate(**item) for item in value["candidates"]),
        tuple(Evidence(**item) for item in value["evidence"]),
        tuple(OperationResult(**item) for item in value["completed"]),
        Budget(**value["budget"]),
        value["anchor_id"],
        value.get("objective"),
    )


def main() -> int:
    ready = False
    ready_version = None
    seen: set[str] = set()
    for raw in iter(lambda: sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1), b""):
        if len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n"):
            return 2
        request = None
        try:
            request = json.loads(
                raw,
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
            version = request.get("protocol_version", 1) if isinstance(request, dict) else 1
            validate("WorkerRequest", request, version=version)
            if ready_version is not None and version != ready_version:
                raise ValueError("worker protocol version changed after handshake")
            if request["request_id"] in seen:
                raise ValueError("duplicate request")
            seen.add(request["request_id"])
            if digest(request["payload"]) != request["input_digest"]:
                raise ValueError("input digest mismatch")
            if request["method"] == "handshake":
                verify_dependencies(Path(__file__).resolve().parents[2])
                if version == 2:
                    from .imports import enforce_declared_imports
                    enforce_declared_imports(Path(__file__).resolve().parents[2])
                result = {
                    "protocol_version": version,
                    **({"operations": [
                        "diagnose_seed",
                        "generate_candidate",
                        "evaluate_seed",
                        "nominate",
                        "stop",
                    ]} if version == 1 else {"effects": ["meta", "candidate", "read", "execute", "score", "library", "stream"]}),
                    "max_message_bytes": MAX_MESSAGE_BYTES,
                    "implementation_identity": source_identity(Path(__file__).resolve().parents[2]),
                }
                ready = True
                ready_version = version
            elif request["method"] == "screen":
                if not ready or version != 2:
                    raise ValueError("v2 handshake required for screening")
                from .resources import bind_resources
                from .screening import project_screening
                body = request["payload"]
                with redirect_stdout(sys.stderr):
                    verify_dependencies(Path(__file__).resolve().parents[2])
                    algorithm = make_algorithm(body["algorithm"])
                    resource_file = Path(__file__).resolve().parents[2] / "resources.json"
                    bind_resources(algorithm, json.loads(resource_file.read_text()) if resource_file.is_file() else [])
                    result = project_screening(algorithm, body)
            else:
                if not ready:
                    raise ValueError("handshake required")
                body = request["payload"]
                if version == 2:
                    from gear.core.state import StateTree
                    from gear.search.api import SearchView as V2SearchView
                    from gear.search.decisions import Decision as V2Decision
                    view = V2SearchView.from_dict(body["view"])
                else:
                    view = decode_view(body["view"])
                if view.run_id != request["run_id"] or view.step_id != request["step_id"]:
                    raise ValueError("envelope ownership mismatch")
                validate("AlgorithmState", body["state"], version=version)
                with redirect_stdout(sys.stderr):
                    verify_dependencies(Path(__file__).resolve().parents[2])
                    algorithm = make_algorithm(body["algorithm"])
                    resource_file = Path(__file__).resolve().parents[2] / "resources.json"
                    if "component" in body["algorithm"] or resource_file.is_file():
                        from .resources import bind_resources
                        bind_resources(algorithm, json.loads(resource_file.read_text()) if resource_file.is_file() else [])
                    if body["algorithm"].get("protocol_version", 1) != version or getattr(algorithm, "protocol_version", 1) != version:
                        raise ValueError("algorithm and worker protocol versions do not match")
                    state = (StateTree.from_state_dict(body["state"], expected_version=getattr(algorithm, "state_schema_version", 1))
                             if version == 2 else AlgorithmState(**body["state"]))
                    decision = algorithm.step(view, state)
                    if inspect.isawaitable(decision):
                        raise TypeError("algorithm step must be a pure synchronous decision")
                    if version == 2:
                        if not isinstance(decision, V2Decision):
                            raise TypeError("v2 algorithms must return gear.search.Decision")
                        result = decision.to_dict()
                    else:
                        result = asdict(decision)
                # Dataclass tuples are wire arrays.
                result = json.loads(json.dumps(result, allow_nan=False))
                validate("Decision", result, version=version)
            response = {
                key: request[key]
                for key in (
                    "protocol_version",
                    "request_id",
                    "run_id",
                    "step_id",
                    "input_digest",
                )
            }
            response.update(result=result, error=None)
        except Exception as error:
            if not isinstance(request, dict) or not all(
                key in request for key in ("request_id", "run_id", "step_id", "input_digest")
            ):
                return 2
            response = {
                key: request[key]
                for key in (
                    "protocol_version",
                    "request_id",
                    "run_id",
                    "step_id",
                    "input_digest",
                )
            }
            response.update(
                result=None,
                error={
                    "code": "algorithm-invalid-output" if ready else "protocol-handshake-failed",
                    "message": str(error)[:2000],
                },
            )
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(encoded) > MAX_MESSAGE_BYTES:
            return 2
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
