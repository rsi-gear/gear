"""Explicit Meta fixture that consumes verified repairs; no model-effect claim."""

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))
sys.path.insert(0, str(ROOT / "python/tests"))

from agentr_harness import CONTEXT_NOTE  # noqa: E402
from fixtures.sentinel_provider import FixtureCalls as RetailCalls  # noqa: E402
from ifeval_experiment import read_json  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, freeze  # noqa: E402
from sentinel_provider import respond  # noqa: E402


class FixtureCalls(RetailCalls):
    identity = "explicit-agentr-search-model-fixture-v1"

    async def call(self, key, prompt, harness, **settings):
        if key.startswith(("solve/", "user/")) or key == "policy-audit":
            key = "direct/" + key
        if not key.endswith("/meta"):
            return await super().call(key, prompt, harness, **settings)
        request = {"key": key, "prompt": prompt, "harness": harness, "settings": settings}
        if self.path(key).exists():
            saved = read_json(self.path(key))
            if saved["request"] != request:
                raise ValueError("Agent-R Meta fixture request changed")
            return saved["receipt"]
        if len(list(self.root.glob("*.json"))) >= self.max_calls:
            raise RuntimeError("fixture logical call quota exhausted")
        for private in ("PRIVATE_DEV", "PRIVATE_TEST", "evaluation_criteria", "user_scenario"):
            if private in prompt:
                raise AssertionError("private task material leaked to Agent-R Meta")
        suffix = ""
        if CONTEXT_NOTE in prompt:
            material = json.loads(prompt.split(CONTEXT_NOTE, 1)[1])["agentr_repairs"]
            for row in material:
                for repair in row["repairs"]:
                    if (
                        repair["verdict"]["repaired_native_reward"] != 1
                        or repair["restoration"]["mechanism"] != "fresh-retail-db-replay"
                        or not repair["failure_conversation"]
                        or not repair["repaired_conversation"]
                    ):
                        raise AssertionError("Meta fixture needs executed repair evidence")
            suffix = " CHECK_TARGET_ORDER SOLVE_WITH_TOOLS"
        response = {
            "text": EXPLORER_PROMPT + suffix
            if prompt.startswith("Revise")
            else "oversized proposal " * 180
        }
        receipt = {
            "response": json.dumps(response),
            "status": "completed",
            "usage": None,
            "fixture": True,
        }
        freeze(self.path(key), {"request": request, "receipt": receipt})
        with (self.root / "submitted.jsonl").open("a") as stream:
            stream.write(json.dumps(key) + "\n")
        return receipt


class InterruptedCalls(FixtureCalls):
    async def call(self, key, *args, **settings):
        receipt = await super().call(key, *args, **settings)
        marker = self.root / "interrupted"
        if key.endswith("/meta") and not marker.exists():
            marker.write_text(key)
            raise OSError("lost completed Agent-R Meta response")
        return receipt


if __name__ == "__main__":
    print(json.dumps(asyncio.run(respond(json.load(sys.stdin), calls_factory=FixtureCalls))))
