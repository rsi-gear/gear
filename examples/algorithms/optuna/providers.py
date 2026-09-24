"""Trusted local CPU example providers; evaluation is a Gear operation."""
from pathlib import Path

from gear_algorithm import DurableLocalProvider, ProviderManifest
from gear_algorithm.adapters.optuna import OptunaAskProvider, OptunaTellProvider

KEY = (Path(__file__).resolve().parent / "checkpoint.key").read_bytes()
ask_provider = OptunaAskProvider(checkpoint_key=KEY)
tell_provider = OptunaTellProvider(checkpoint_key=KEY)


class CpuObjective(DurableLocalProvider):
    def __init__(self):
        super().__init__(ProviderManifest("experiment.evaluate", {
            "type": "object", "properties": {
                "trialNumber": {"type": "integer"},
                "params": {"type": "object", "additionalProperties": {"type": "any"}},
            }, "required": ["trialNumber", "params"], "additionalProperties": False,
        }, {"type": "object", "properties": {"objective": {"type": "number"}},
            "required": ["objective"], "additionalProperties": False},
            meteredDimensions=("evaluation.calls",)))

    def execute(self, request):
        x = request["input"]["params"]["x"]
        return {"kind": "result", "value": {"objective": (x - 0.25) ** 2}}

    def usage_receipt(self, request, outcome):
        return {"source": "experiment.evaluate", "scope": "operation",
                "operationId": request["operationId"], "cursor": "final",
                "cumulative": {"evaluation.calls": 1}}


evaluate_provider = CpuObjective()
