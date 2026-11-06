"""Exact UTF-8/newline capacity boundaries for the production stdio worker."""

import io
import json
import unittest
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import patch

from gear.algorithms import AlgorithmState, Decision
from gear.canonical import digest
from gear.refine import worker
from gear.refine.protocol import MAX_MESSAGE_BYTES

IDENTITY = "sha256:" + "0" * 64


def request(method, payload):
    return {
        "protocol_version": 1,
        "request_id": method,
        "run_id": "run",
        "step_id": 0,
        "input_digest": digest(payload),
        "method": method,
        "payload": payload,
    }


def encode(value, *, compact=False):
    options = {"separators": (",", ":")} if compact else {}
    return json.dumps(value, ensure_ascii=False, allow_nan=False, **options).encode() + b"\n"


def response(message, decision):
    result = {
        key: message[key]
        for key in ("protocol_version", "request_id", "run_id", "step_id", "input_digest")
    }
    result.update(result=asdict(decision), error=None)
    return result


class AlgorithmProtocolTests(unittest.TestCase):
    def execute(self, raw, decision=None):
        output = io.BytesIO()
        with (
            patch.object(worker.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(raw))),
            patch.object(worker.sys, "stdout", SimpleNamespace(buffer=output)),
            patch.object(worker, "verify_dependencies"),
            patch.object(worker, "source_identity", return_value=IDENTITY),
            patch.object(
                worker,
                "make_algorithm",
                return_value=SimpleNamespace(step=lambda view, state: decision),
            ),
        ):
            status = worker.main()
        return status, output.getvalue()

    def test_input_boundary_counts_utf8_envelope_and_newline_at_the_actual_limit(self):
        self.assertEqual(MAX_MESSAGE_BYTES, 64 * 1024 * 1024)
        for excess in (0, 1):
            with self.subTest(excess=excess):
                payload = {"implementation_identity": IDENTITY, "utf8": "é\n", "padding": ""}
                message = request("handshake", payload)
                payload["padding"] += "x" * (
                    MAX_MESSAGE_BYTES + excess - len(encode(message, compact=True))
                )
                message["input_digest"] = digest(payload)
                encoded = encode(message, compact=True)
                self.assertEqual(len(encoded), MAX_MESSAGE_BYTES + excess)
                status, output = self.execute(encoded)
                self.assertEqual(status, 2 if excess else 0)
                if excess:
                    self.assertEqual(output, b"")
                else:
                    result = json.loads(output)["result"]
                    self.assertEqual(result["max_message_bytes"], MAX_MESSAGE_BYTES)
                    self.assertEqual(result["implementation_identity"], IDENTITY)

    def test_input_rejects_a_frame_without_its_required_newline(self):
        status, output = self.execute(encode(request("handshake", {}), compact=True)[:-1])
        self.assertEqual((status, output), (2, b""))

    def test_output_boundary_counts_utf8_envelope_and_newline_at_the_actual_limit(self):
        view = {
            "run_id": "run",
            "step_id": 0,
            "seed": "fixed",
            "tasks": [],
            "candidates": [],
            "evidence": [],
            "completed": [],
            "anchor_id": "anchor",
            "budget": {
                "evaluations_remaining": 1,
                "candidates_remaining": 1,
                "rounds": 1,
                "repetitions": 1,
            },
        }
        step = request(
            "step",
            {
                "view": view,
                "state": {"version": 1, "data": {}},
                "algorithm": {"name": "synthetic", "options": {}},
            },
        )
        raw = encode(request("handshake", {}), compact=True) + encode(step, compact=True)
        for excess in (0, 1):
            with self.subTest(excess=excess):
                state = AlgorithmState(data={"retained": "retained-state é\n", "padding": ""})
                prefix = "response é\n"
                base = Decision(state, (), prefix)
                state.data["padding"] = "x" * (
                    MAX_MESSAGE_BYTES + excess - len(encode(response(step, base)))
                )
                decision = Decision(state, (), prefix)
                self.assertEqual(len(encode(response(step, decision))), MAX_MESSAGE_BYTES + excess)
                status, output = self.execute(raw, decision)
                self.assertEqual(status, 2 if excess else 0)
                lines = output.splitlines(keepends=True)
                self.assertEqual(len(lines), 1 if excess else 2)
                if not excess:
                    self.assertEqual(len(lines[1]), MAX_MESSAGE_BYTES)
                    result = json.loads(lines[1])["result"]
                    self.assertEqual(result["reason"], prefix)
                    self.assertEqual(result["state"], asdict(state))


if __name__ == "__main__":
    unittest.main()
