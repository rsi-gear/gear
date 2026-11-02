"""Versioned stdio algorithm worker. The parent runtime must provide an OS sandbox."""

from __future__ import annotations

import importlib
import inspect
import json
import sys
from contextlib import redirect_stdout
from dataclasses import asdict
from pathlib import Path

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    RandomSearch,
    SearchView,
    Task,
)
from gear.canonical import digest

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


def make_algorithm(config):
    options = dict(config.get("options", {}))
    for key in ("parent_policy", "sampler", "proposal_planner", "ranker", "stop_rule"):
        if key in options:
            value = options[key]
            if isinstance(value, str):
                options[key] = load_entrypoint(value)
            elif (
                isinstance(value, dict)
                and set(value) == {"entrypoint", "configuration"}
                and isinstance(value["configuration"], dict)
            ):
                options[key] = load_entrypoint(value["entrypoint"])(**value["configuration"])
            else:
                raise ValueError("policy requires an entrypoint or a configured entrypoint object")
    if config["name"] == "gepa":
        return GEPA(**options)
    if config["name"] == "random-search":
        return RandomSearch(**options)
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
            validate("WorkerRequest", request)
            if request["request_id"] in seen:
                raise ValueError("duplicate request")
            seen.add(request["request_id"])
            if digest(request["payload"]) != request["input_digest"]:
                raise ValueError("input digest mismatch")
            if request["method"] == "handshake":
                verify_dependencies(Path(__file__).resolve().parents[2])
                result = {
                    "protocol_version": 1,
                    "operations": [
                        "diagnose_seed",
                        "generate_candidate",
                        "evaluate_seed",
                        "nominate",
                        "stop",
                    ],
                    "max_message_bytes": MAX_MESSAGE_BYTES,
                    "implementation_identity": source_identity(Path(__file__).resolve().parents[2]),
                }
                ready = True
            else:
                if not ready:
                    raise ValueError("handshake required")
                body = request["payload"]
                view = decode_view(body["view"])
                if view.run_id != request["run_id"] or view.step_id != request["step_id"]:
                    raise ValueError("envelope ownership mismatch")
                validate("AlgorithmState", body["state"])
                with redirect_stdout(sys.stderr):
                    verify_dependencies(Path(__file__).resolve().parents[2])
                    algorithm = make_algorithm(body["algorithm"])
                    decision = algorithm.step(view, AlgorithmState(**body["state"]))
                    if inspect.isawaitable(decision):
                        raise TypeError("algorithm step must be a pure synchronous decision")
                    result = asdict(decision)
                # Dataclass tuples are wire arrays.
                result = json.loads(json.dumps(result, allow_nan=False))
                validate("Decision", result)
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
