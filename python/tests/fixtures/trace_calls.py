"""Explicit model fixtures; solver actions use only public environment messages."""

import json
import re

from fixtures.trace_game import source


class TraceCalls:
    identity = "explicit-trace-fixture-v1"

    def __init__(self, *, max_calls=64, passed=None, novel=True, code_prefixes=()):
        self.max_calls = max_calls
        self.passed = passed
        self.novel = novel
        self.code_prefixes = code_prefixes
        self.receipts = {}
        self.submissions = []
        self.interrupt_key = None
        self.unknown_key = None

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            previous, receipt = self.receipts[key]
            if request != previous:
                raise ValueError("TRACE fixture request changed")
            return receipt
        if len(self.submissions) >= self.max_calls:
            raise RuntimeError("fixture quota exhausted")
        self.submissions.append(key)
        if key == self.unknown_key:
            return {"status": "unknown", "fixture": True}
        data = json.loads(prompt)
        if key == "discover":
            response = {
                "capabilities": [
                    {
                        "name": "structured-evidence",
                        "description": "Read related retail records and infer a supported result.",
                    }
                ]
            }
        elif key.startswith("label-"):
            response = {
                "labels": [
                    {
                        "capability_id": capability,
                        "case_id": case["case_id"],
                        "label": "LACKING" if case["outcome"] == "failure" else "PRESENT",
                        "reason": "Explicit test annotation, not a real model judgment.",
                    }
                    for capability in data["capabilities"]
                    for case in data["cases"]
                ]
            }
        elif key.endswith("/generate"):
            revision = int(key.split("/")[1])
            prefix = self.code_prefixes[revision] if revision < len(self.code_prefixes) else ""
            response = {
                "code": prefix + source(data["source_tools"]),
                "transfer_rationale": "Explicit generated-code fixture for pipeline validation.",
            }
        elif key.endswith("/audit"):
            response = {
                "valid": True,
                "faithful": True,
                "format_preserved": True,
                "hides_solution": True,
                "novel": self.novel,
                "reason": "Explicit semantic fixture; this does not prove benchmark transfer.",
            }
        elif "/solve/" in key or key.startswith("solve/"):
            assert set(data) == {"system_prompt", "tools", "messages"}
            passed = self.passed
            if passed is None:
                passed = int(key.split("/samples/")[1].split("/")[1]) % 2 == 0
            response = self.solve(data, passed=passed)
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
            raise OSError("lost completed TRACE response before execution")
        return receipt

    @staticmethod
    def solve(data, *, passed):
        if not passed:
            action = "respond_to_user", {"message": "I do not know."}
        else:
            observed = [
                json.loads(row["content"]) for row in data["messages"] if row["role"] == "tool"
            ]
            if not observed:
                user_id = re.search(r"My user ID is (\w+)\.", data["messages"][0]["content"]).group(
                    1
                )
                action = "get_user_details", {"user_id": user_id}
            else:
                orders = observed[0]["orders"]
                if len(observed) <= len(orders):
                    action = "get_order_details", {"order_id": orders[len(observed) - 1]}
                else:
                    answer = max(observed[1:], key=lambda row: row["items"][0]["price"])
                    action = "respond_to_user", {"message": answer["order_id"]}
        return {"name": action[0], "arguments_json": json.dumps(action[1])}
