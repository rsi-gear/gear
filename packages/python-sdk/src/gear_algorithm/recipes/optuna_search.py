"""Small ask → external Gear evaluation → tell workflow for the optional Optuna SPI."""
from __future__ import annotations

import math
from typing import Any

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import AlgorithmManifest
from gear_algorithm.steps import operation
from .common import OPERATION_LIMITS_SCHEMA, advance_state, apply_operation_limits, result


class OptunaSearch:
    def describe(self) -> AlgorithmManifest:
        return AlgorithmManifest("optuna.gear-evaluation", {"type": "object"}, {
            "type": "object", "properties": {
                "studyName": {"type": "string"}, "direction": {"type": "string", "enum": ["minimize", "maximize"]},
                "sampler": {"type": "string", "enum": ["random", "tpe"]}, "seed": {"type": "integer"},
                "space": {"type": "object", "additionalProperties": {"type": "any"}},
                "trials": {"type": "integer"}, "evaluationKind": {"type": "string"},
                "operationLimits": OPERATION_LIMITS_SCHEMA,
            }, "required": ["studyName", "direction", "sampler", "seed", "space", "trials", "evaluationKind"],
            "additionalProperties": False,
        }, {"id": "optuna.bindings.v1", "slots": {}})

    @staticmethod
    def _ask(state: dict[str, Any], config: dict[str, Any]):
        input_value = {key: config[key] for key in ("studyName", "direction", "sampler", "seed", "space")}
        if state["checkpointRef"] is not None:
            input_value["checkpointRef"] = state["checkpointRef"]
        return advance_state({**state, "phase": "ask"}, [
            operation(key="optuna.ask", kind="optuna.ask", input=input_value)])

    def initialize(self, context: dict[str, Any]):
        return apply_operation_limits(self._initialize(context), context["config"],
                                      self._kinds(context["config"]))

    @staticmethod
    def _kinds(config: dict[str, Any]) -> frozenset[str]:
        return frozenset({"optuna.ask", "optuna.tell", config["evaluationKind"]})

    def _initialize(self, context: dict[str, Any]):
        config = context["config"]
        if config["trials"] < 1 or config["evaluationKind"] in ("optuna.ask", "optuna.tell"):
            raise ValidationError("Optuna needs positive trials and a separate Gear evaluation provider")
        return self._ask({"phase": "ask", "checkpointRef": None, "finished": []}, config)

    def reduce(self, context: dict[str, Any]):
        return apply_operation_limits(self._reduce(context), context["config"],
                                      self._kinds(context["config"]))

    def _reduce(self, context: dict[str, Any]):
        state = context["state"]
        config = context["config"]
        if state["phase"] == "ask":
            asked = result(context, "optuna.ask")
            return advance_state({**state, "phase": "evaluate", "asked": asked}, [
                operation(key="trial.evaluate", kind=config["evaluationKind"], input={
                    "trialNumber": asked["trialNumber"], "params": asked["params"]})])
        if state["phase"] == "evaluate":
            outcome = context["completed"]["trial.evaluate"]
            asked = state["asked"]
            if outcome["kind"] == "result":
                result_value = outcome["value"]
                objective = result_value.get("objective") if isinstance(result_value, dict) else None
                if not isinstance(objective, (int, float)) or isinstance(objective, bool) or not math.isfinite(objective):
                    raise ValidationError("Gear trial evaluation needs a finite objective")
                tell_input = {"checkpointRef": asked["checkpointRef"], "trialNumber": asked["trialNumber"],
                              "state": "COMPLETE", "value": float(objective)}
            elif outcome["kind"] in ("no-result", "inconclusive", "error"):
                tell_input = {"checkpointRef": asked["checkpointRef"], "trialNumber": asked["trialNumber"],
                              "state": "FAIL"}
            else:
                raise ValidationError("Unsupported Gear trial evaluation outcome")
            return advance_state({**state, "phase": "tell", "evaluationOutcome": outcome}, [
                operation(key="optuna.tell", kind="optuna.tell", input=tell_input)])
        if state["phase"] == "tell":
            told = result(context, "optuna.tell")
            finished = [*state["finished"], {
                "trialNumber": state["asked"]["trialNumber"], "params": state["asked"]["params"],
                "evaluationOutcome": state["evaluationOutcome"], "tellState": told["state"],
            }]
            next_state = {"phase": "ask", "checkpointRef": told["checkpointRef"], "finished": finished}
            if len(finished) == config["trials"]:
                return advance_state({**next_state, "phase": "done",
                                      "bestValue": told.get("bestValue")}, complete=True)
            return self._ask(next_state, config)
        raise ValidationError(f"Unknown Optuna phase {state['phase']}")


algorithm = OptunaSearch()
