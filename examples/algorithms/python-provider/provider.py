"""Deterministic fake SFT/DPO provider: protocol example, no model training."""
from __future__ import annotations

import json

from gear_algorithm import DurableLocalProvider, ProviderManifest, ValidationError

INPUT = {"type": "object", "properties": {
    "mode": {"type": "string", "enum": ["sft", "dpo"]},
    "samples": {"type": "integer"}},
    "required": ["mode", "samples"], "additionalProperties": False}
OUTPUT = {"type": "object", "properties": {
    "mode": {"type": "string"}, "checkpoint": {"type": "object"}},
    "required": ["mode", "checkpoint"], "additionalProperties": False}


class FakeTrainer(DurableLocalProvider):
    def __init__(self, record_dir: str | None = None) -> None:
        super().__init__(ProviderManifest("training.fake_sft_dpo", INPUT, OUTPUT), record_dir)

    def execute(self, request):
        inputs = request["input"]
        if inputs["samples"] < 0:
            raise ValidationError("samples must be nonnegative")
        if inputs["samples"] == 0:
            return {"kind": "no-result", "reason": "no candidate"}
        if self.artifacts is None:
            raise ValidationError("artifact bridge is unavailable")
        checkpoint = self.artifacts.write(
            json.dumps({"fakeWeights": inputs["samples"], "mode": inputs["mode"]}, sort_keys=True).encode(),
            media_type="application/vnd.gear.fake-checkpoint+json", schema_id="fake-checkpoint-v1")
        return {"kind": "result", "value": {"mode": inputs["mode"], "checkpoint": checkpoint.to_wire()}}


provider = FakeTrainer()
