"""Explicit model fixture for the production retail process-provider integration."""

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))

from gear.canonical import digest  # noqa: E402
from ifeval import read_json  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, freeze  # noqa: E402
from sentinel_provider import respond  # noqa: E402


class FixtureCalls:
    identity = "explicit-retail-search-model-fixture-v1"
    timeout_seconds = 240

    def __init__(self, root, *, max_calls, concurrency=1, timeout_seconds=240, delay_seconds=0):
        self.root, self.max_calls = Path(root).resolve(), max_calls
        self.timeout_seconds = timeout_seconds
        self.delay_seconds = delay_seconds
        self.root.mkdir(parents=True, exist_ok=True)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def path(self, key):
        return self.root / (digest(key).removeprefix("sha256:") + ".json")

    async def inspect(self, key):
        if self.path(key).exists():
            return "complete", read_json(self.path(key))["receipt"]
        return "not_submitted", None

    async def call(self, key, prompt, harness, **settings):
        request = {
            "key": key,
            "prompt": prompt,
            "harness": harness,
            "settings": settings,
            "timeout_seconds": self.timeout_seconds,
            "delay_seconds": self.delay_seconds,
        }
        if self.path(key).exists():
            saved = read_json(self.path(key))
            if saved["request"] != request:
                raise ValueError("fixture key changed request")
            return saved["receipt"]
        if len(list(self.root.glob("*.json"))) >= self.max_calls:
            raise RuntimeError("fixture logical call quota exhausted")
        receipt = await self.make_receipt(key, prompt, harness, **settings)
        freeze(self.path(key), {"request": request, "receipt": receipt})
        with (self.root / "submitted.jsonl").open("a") as stream:
            stream.write(json.dumps(key) + "\n")
        return receipt

    async def make_receipt(self, key, prompt, harness, **settings):
        if key.endswith("/meta"):
            if "PRIVATE_DEV" in prompt or "PRIVATE_TEST" in prompt:
                raise AssertionError("private task material leaked to Meta")
            response = {
                "text": EXPLORER_PROMPT + " SOLVE_WITH_TOOLS " + digest(prompt)[-12:]
                if prompt.startswith("Revise")
                else "oversized proposal " * 180
            }
        elif "/solve/" in key:
            index = int(key.rsplit("/", 1)[1])
            actions = (
                [
                    ("tool", "find_user_id_by_email", {"email": "alex@gear.example"}, ""),
                    ("tool", "get_order_details", {"order_id": "#G100"}, ""),
                    (
                        "message",
                        "",
                        {},
                        "Confirm cancellation of pending #G100 because it is no longer needed, refunding $10 to your original Visa 0000 in 5 to 7 business days?",
                    ),
                    (
                        "tool",
                        "cancel_pending_order",
                        {"order_id": "#G100", "reason": "no longer needed"},
                        "",
                    ),
                    (
                        "finish",
                        "",
                        {},
                        "Your order #G100 is cancelled and the original card will receive the $10 refund.",
                    ),
                ]
                if "SOLVE_WITH_TOOLS" in harness
                else [("finish", "", {}, "I would next verify your account.")]
            )
            kind, name, arguments, text = actions[index]
            response = {
                "kind": kind,
                "name": name,
                "arguments_json": json.dumps(arguments),
                "text": text,
            }
            response = {"action": response}
        elif "/user/" in key:
            response = {
                "message": "Yes, cancel #G100 for that reason and refund the original card as described."
            }
        elif key.endswith("/policy-audit"):
            response = {
                "policy_compliant": True,
                "reason": "Explicit semantic model fixture; native DB grading is real.",
            }
        else:
            raise AssertionError(key)
        return self.completed(response)

    @staticmethod
    def completed(response):
        return {
            "response": json.dumps(response),
            "status": "completed",
            "usage": None,
            "fixture": True,
        }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(respond(json.load(sys.stdin), calls_factory=FixtureCalls))))
