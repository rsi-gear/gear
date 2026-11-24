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
from sentinel_generate import EXPLORER_PROMPT  # noqa: E402
from sentinel_provider import respond  # noqa: E402


class FixtureCalls(RetailCalls):
    identity = "explicit-agentr-search-model-fixture-v1"

    async def call(self, key, prompt, harness, **settings):
        if key.startswith(("solve/", "user/")) or key == "policy-audit":
            key = "direct/" + key
        return await super().call(key, prompt, harness, **settings)

    async def make_receipt(self, key, prompt, harness, **settings):
        if not key.endswith("/meta"):
            return await super().make_receipt(key, prompt, harness, **settings)
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
        return self.completed(response)


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
