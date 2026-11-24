"""Explicit model fixture for mixed native retail and generated environment search."""

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))
sys.path.insert(0, str(ROOT / "python/tests"))

from fixtures.sentinel_provider import FixtureCalls as RetailCalls  # noqa: E402
from fixtures.trace_calls import TraceCalls  # noqa: E402
from sentinel_provider import respond  # noqa: E402


class FixtureCalls(RetailCalls):
    identity = "explicit-trace-search-model-fixture-v1"

    async def call(self, key, prompt, harness, **settings):
        if key.startswith(("solve/", "user/")) or key == "policy-audit":
            key = "direct/" + key
        return await super().call(key, prompt, harness, **settings)

    async def make_receipt(self, key, prompt, harness, **settings):
        if "/solve/" not in key:
            return await super().make_receipt(key, prompt, harness, **settings)
        data = json.loads(prompt)
        if "system_prompt" not in data:
            return await super().make_receipt(key, prompt, harness, **settings)
        if set(data) != {"system_prompt", "tools", "messages"}:
            raise AssertionError("TRACE private environment material leaked to solver")
        response = TraceCalls.solve(data, passed="SOLVE_WITH_TOOLS" in harness)
        return self.completed(response)


class InterruptedCalls(FixtureCalls):
    async def call(self, key, *args, **settings):
        receipt = await super().call(key, *args, **settings)
        marker = self.root / "interrupted"
        if key.endswith("/solve/2") and not marker.exists():
            marker.write_text(key)
            raise OSError("lost completed TRACE tool decision")
        return receipt


if __name__ == "__main__":
    print(json.dumps(asyncio.run(respond(json.load(sys.stdin), calls_factory=FixtureCalls))))
