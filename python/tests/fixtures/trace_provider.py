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
from ifeval_experiment import read_json  # noqa: E402
from sentinel_generate import freeze  # noqa: E402
from sentinel_provider import respond  # noqa: E402


class FixtureCalls(RetailCalls):
    identity = "explicit-trace-search-model-fixture-v1"

    async def call(self, key, prompt, harness, **settings):
        if key.startswith(("solve/", "user/")) or key == "policy-audit":
            key = "direct/" + key
        if "/solve/" not in key:
            return await super().call(key, prompt, harness, **settings)
        data = json.loads(prompt)
        if "system_prompt" not in data:
            return await super().call(key, prompt, harness, **settings)
        if set(data) != {"system_prompt", "tools", "messages"}:
            raise AssertionError("TRACE private environment material leaked to solver")
        request = {"key": key, "prompt": prompt, "harness": harness, "settings": settings}
        if self.path(key).exists():
            saved = read_json(self.path(key))
            if saved["request"] != request:
                raise ValueError("TRACE fixture key changed request")
            return saved["receipt"]
        if len(list(self.root.glob("*.json"))) >= self.max_calls:
            raise RuntimeError("fixture logical call quota exhausted")
        response = TraceCalls.solve(data, passed="SOLVE_WITH_TOOLS" in harness)
        receipt = {
            "status": "completed",
            "response": json.dumps(response),
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
        if key.endswith("/solve/2") and not marker.exists():
            marker.write_text(key)
            raise OSError("lost completed TRACE tool decision")
        return receipt


if __name__ == "__main__":
    print(json.dumps(asyncio.run(respond(json.load(sys.stdin), calls_factory=FixtureCalls))))
