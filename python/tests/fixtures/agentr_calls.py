"""Explicit Agent-R model responses; never used as real model-effect evidence."""

import copy
import json


class AgentRCalls:
    identity = "explicit-agentr-fixture-v1"

    def __init__(self, steps, *, max_calls=100, mode="success", boundary="bad"):
        self.steps = copy.deepcopy(steps)
        self.max_calls = max_calls
        self.mode, self.boundary = mode, boundary
        self.receipts, self.submissions = {}, []
        self.interrupt_key = None
        self.unknown_key = None
        self.boundary_at = None

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            previous, receipt = self.receipts[key]
            if previous != request:
                raise ValueError("Agent-R fixture request changed")
            return receipt
        if len(self.submissions) >= self.max_calls:
            raise RuntimeError("fixture logical-call quota exhausted")
        self.submissions.append(key)
        if key == self.unknown_key:
            return {"status": "unknown", "fixture": True}
        data = json.loads(prompt)
        if key.endswith("/action"):
            index = sum(row["role"] == "assistant" for row in data["conversation"])
            step = self.steps[min(index, len(self.steps) - 1)]
            if (key.startswith("tree/") and (self.mode == "no_success" or "/sample/1/" in key)) or (
                key.startswith("repair/") and self.mode == "repair_failed"
            ):
                step = {"kind": "finish", "text": "I stopped before finishing."}
            if self.mode == "incomplete" or (
                key.startswith("repair/") and self.mode == "repair_incomplete"
            ):
                step = self.steps[1]
            action = step.get("action", {"name": "", "arguments": {}})
            response = {
                "kind": step["kind"],
                "name": action["name"],
                "arguments_json": json.dumps(action["arguments"]),
                "text": step.get("text", ""),
            }
        elif key.endswith("/user"):
            response = {"message": "Yes, cancel #G100 with the refund to my original card."}
        elif key.endswith("/policy-audit"):
            response = {
                "policy_compliant": data["trace"]["steps"][-1]["text"]
                != "I stopped before finishing.",
                "reason": "Explicit semantic fixture, separate from actual DB grading.",
            }
        elif key.startswith("critic/"):
            response = {
                "judgment": (
                    "uncertain"
                    if self.boundary_at is not None and data["step_index"] < self.boundary_at
                    else self.boundary
                ),
                "reason": "The observed write targeted #G200 instead of the confirmed #G100.",
            }
        else:
            raise AssertionError(key)
        receipt = {
            "status": "completed",
            "response": json.dumps(response),
            "fixture": True,
            "usage": {"total": {"total_tokens": 1}},
        }
        self.receipts[key] = request, receipt
        if key == self.interrupt_key:
            self.interrupt_key = None
            raise OSError("lost completed Agent-R response before write execution")
        return receipt
