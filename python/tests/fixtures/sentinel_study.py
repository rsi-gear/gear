"""Explicit deterministic responses; only the retail environment and Gear runtime are real."""

import json

from fixtures.sentinel_provider import FixtureCalls as ProviderCalls
from ifeval_experiment import read_json
from sentinel_generate import freeze
from test_sentinel_retail import FixtureCalls as GenerationCalls


class FixtureCalls(ProviderCalls):
    identity = "explicit-retail-study-model-fixture-v1"
    reject_generated = False

    async def call(self, key, prompt, harness, **settings):
        if key.startswith("solve/") or key == "policy-audit":
            return await super().call("study/" + key, prompt, harness, **settings)
        request = {"key": key, "prompt": prompt, "harness": harness, "settings": settings}
        if self.path(key).exists():
            saved = read_json(self.path(key))
            if saved["request"] != request:
                raise ValueError("study fixture key changed request")
            return saved["receipt"]
        if len(list(self.root.glob("*.json"))) >= self.max_calls:
            raise RuntimeError("fixture logical call quota exhausted")
        response = await GenerationCalls(reject=self.reject_generated).call(
            key, prompt, harness, **settings
        )
        freeze(self.path(key), {"request": request, "receipt": response})
        with (self.root / "submitted.jsonl").open("a") as stream:
            stream.write(json.dumps(key) + "\n")
        return response


class RejectingCalls(FixtureCalls):
    identity = "explicit-rejected-retail-study-fixture-v1"
    reject_generated = True
