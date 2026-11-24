"""Explicit deterministic responses; only the retail environment and Gear runtime are real."""

from fixtures.sentinel_provider import FixtureCalls as ProviderCalls
from test_sentinel_retail import FixtureCalls as GenerationCalls


class FixtureCalls(ProviderCalls):
    identity = "explicit-retail-study-model-fixture-v1"
    reject_generated = False

    async def call(self, key, prompt, harness, **settings):
        if key.startswith("solve/") or key == "policy-audit":
            key = "study/" + key
        return await super().call(key, prompt, harness, **settings)

    async def make_receipt(self, key, prompt, harness, **settings):
        if key.startswith("study/solve/") or key == "study/policy-audit":
            return await super().make_receipt(key, prompt, harness, **settings)
        return await GenerationCalls(reject=self.reject_generated).call(
            key, prompt, harness, **settings
        )


class RejectingCalls(FixtureCalls):
    identity = "explicit-rejected-retail-study-fixture-v1"
    reject_generated = True
