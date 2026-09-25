"""Optuna 4.9 ask/tell as two durable Gear operations.

Only this trusted provider decodes its HMAC-authenticated pickle checkpoint.
Algorithm state and the host wire contain JSON refs, never pickle bytes.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import pickle
from typing import Any

from gear_algorithm.errors import ValidationError
from gear_algorithm.manifest import ProviderManifest
from gear_algorithm.protocol import ArtifactRef, validate_artifact_ref
from gear_algorithm.provider import ArtifactClient, DurableLocalProvider

_VERSION = "4.9.0"
_SCHEMA_ID = "optuna.study.v1"
_MAGIC = b"GEAR_OPTUNA_4_9_STUDY\n"
# Artifact put/get uses one base64 JSON frame capped at 4 MiB by the S2 host.
# Keep the trusted study payload well below that transport ceiling.
_MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024
_REF = {"type": "any"}
_SPACE = {"type": "object", "additionalProperties": {"type": "any"}}
_ASK_INPUT = {"type": "object", "properties": {
    "studyName": {"type": "string"}, "direction": {"type": "string", "enum": ["maximize", "minimize"]},
    "sampler": {"type": "string", "enum": ["random", "tpe"]}, "seed": {"type": "integer"},
    "space": _SPACE, "checkpointRef": _REF,
}, "required": ["studyName", "direction", "sampler", "seed", "space"], "additionalProperties": False}
_ASK_OUTPUT = {"type": "object", "properties": {
    "trialNumber": {"type": "integer"}, "params": _SPACE, "checkpointRef": _REF,
}, "required": ["trialNumber", "params", "checkpointRef"], "additionalProperties": False}
_TELL_INPUT = {"type": "object", "properties": {
    "checkpointRef": _REF, "trialNumber": {"type": "integer"},
    "state": {"type": "string", "enum": ["COMPLETE", "FAIL", "PRUNED"]}, "value": {"type": "number"},
}, "required": ["checkpointRef", "trialNumber", "state"], "additionalProperties": False}
_TELL_OUTPUT = {"type": "object", "properties": {
    "checkpointRef": _REF, "trialNumber": {"type": "integer"}, "state": {"type": "string"},
    "bestValue": {"type": "number"},
}, "required": ["checkpointRef", "trialNumber", "state"], "additionalProperties": False}


def _optuna():
    try:
        import optuna
    except ImportError as exc:
        raise ValidationError("Optuna adapter requires optional optuna==4.9.0") from exc
    if optuna.__version__ != _VERSION:
        raise ValidationError(f"Optuna checkpoint requires {_VERSION}, found {optuna.__version__}")
    return optuna


def _artifact(ref: dict[str, Any]) -> ArtifactRef:
    validate_artifact_ref(ref)
    if ref.get("schemaId") != _SCHEMA_ID:
        raise ValidationError("Not an Optuna provider checkpoint")
    return ArtifactRef(digest=ref["digest"], size=ref["size"], mediaType=ref["mediaType"],
                       schemaId=ref["schemaId"])


class _CheckpointProvider(DurableLocalProvider):
    def __init__(self, kind: str, input_schema: dict[str, Any], output_schema: dict[str, Any],
                 *, checkpoint_key: bytes, record_dir: str | None = None,
                 artifacts: ArtifactClient | None = None) -> None:
        _optuna()  # Fail admission/check on a missing or mismatched scientific library.
        if not isinstance(checkpoint_key, bytes) or len(checkpoint_key) < 32:
            raise ValidationError("Optuna checkpoint key needs at least 32 bytes")
        self._checkpoint_key = checkpoint_key
        self.checkpoint_key_digest = hashlib.sha256(checkpoint_key).hexdigest()
        super().__init__(ProviderManifest(kind, input_schema, output_schema), record_dir, artifacts)

    def describe(self) -> dict[str, Any]:
        # Loader seals this key identity into implementationDigest, without exposing the key.
        return {**self.manifest.to_wire(), "optunaVersion": _VERSION,
                "checkpointKeyDigest": self.checkpoint_key_digest}

    def _client(self) -> ArtifactClient:
        if self.artifacts is None:
            raise ValidationError("Optuna provider needs a host artifact bridge")
        return self.artifacts

    def _seal(self, study: Any, configuration: dict[str, Any]) -> dict[str, Any]:
        payload = pickle.dumps({"study": study, "configuration": configuration}, protocol=5)
        if len(payload) > _MAX_CHECKPOINT_BYTES:
            raise ValidationError("Optuna checkpoint exceeds provider limit")
        signature = hmac.new(self._checkpoint_key, payload, hashlib.sha256).hexdigest().encode("ascii")
        return self._client().write(_MAGIC + signature + b"\n" + payload,
                                    media_type="application/vnd.gear.optuna-study", schema_id=_SCHEMA_ID).to_wire()

    def _load(self, wire: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        ref = _artifact(wire)
        raw = self._client().read(ref)
        if len(raw) > _MAX_CHECKPOINT_BYTES + len(_MAGIC) + 65 or not raw.startswith(_MAGIC):
            raise ValidationError("Invalid Optuna checkpoint framing")
        signature, separator, payload = raw[len(_MAGIC):].partition(b"\n")
        if separator != b"\n" or len(signature) != 64:
            raise ValidationError("Invalid Optuna checkpoint signature")
        expected = hmac.new(self._checkpoint_key, payload, hashlib.sha256).hexdigest().encode("ascii")
        if not hmac.compare_digest(signature, expected):
            raise ValidationError("Optuna checkpoint authentication failed")
        # Unpickle only our own authenticated blob in this trusted provider environment.
        value = pickle.loads(payload)
        if not isinstance(value, dict) or not isinstance(value.get("configuration"), dict):
            raise ValidationError("Malformed Optuna checkpoint")
        return value["study"], value["configuration"]


def _distributions(space: dict[str, Any]) -> dict[str, Any]:
    optuna = _optuna()
    if not isinstance(space, dict) or not space:
        raise ValidationError("Optuna search space must be nonempty")
    result = {}
    for name, item in space.items():
        if not isinstance(name, str) or not name or not isinstance(item, dict):
            raise ValidationError("Invalid Optuna parameter")
        kind = item.get("type")
        if kind == "float":
            result[name] = optuna.distributions.FloatDistribution(
                item["low"], item["high"], log=item.get("log", False), step=item.get("step"))
        elif kind == "int":
            result[name] = optuna.distributions.IntDistribution(
                item["low"], item["high"], log=item.get("log", False), step=item.get("step", 1))
        elif kind == "categorical":
            result[name] = optuna.distributions.CategoricalDistribution(item["choices"])
        else:
            raise ValidationError(f"Unsupported Optuna distribution for {name}")
    return result


class OptunaAskProvider(_CheckpointProvider):
    def __init__(self, *, checkpoint_key: bytes, record_dir: str | None = None,
                 artifacts: ArtifactClient | None = None) -> None:
        super().__init__("optuna.ask", _ASK_INPUT, _ASK_OUTPUT, checkpoint_key=checkpoint_key,
                         record_dir=record_dir, artifacts=artifacts)

    def preflight(self, request: dict[str, Any]) -> dict[str, Any]:
        checked = super().preflight(request)
        value = request["input"]
        if not value["studyName"]:
            raise ValidationError("Optuna study name must not be empty")
        _distributions(value["space"])
        if "checkpointRef" in value:
            study, frozen = self._load(value["checkpointRef"])
            expected = {key: value[key] for key in ("studyName", "direction", "sampler", "seed", "space")}
            if frozen != expected:
                raise ValidationError("Optuna study configuration drift")
            optuna = _optuna()
            if any(item.state == optuna.trial.TrialState.RUNNING for item in study.get_trials(deepcopy=False)):
                raise ValidationError("Tell the running Optuna trial before asking again")
        return checked

    def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        optuna = _optuna()
        input_value = request["input"]
        configuration = {key: input_value[key] for key in ("studyName", "direction", "sampler", "seed", "space")}
        distributions = _distributions(configuration["space"])
        if "checkpointRef" in input_value:
            study, frozen = self._load(input_value["checkpointRef"])
            if frozen != configuration:
                raise ValidationError("Optuna study configuration drift")
        else:
            sampler = (optuna.samplers.RandomSampler(seed=configuration["seed"])
                       if configuration["sampler"] == "random" else optuna.samplers.TPESampler(seed=configuration["seed"]))
            study = optuna.create_study(study_name=configuration["studyName"],
                                        direction=configuration["direction"], sampler=sampler)
        if any(item.state == optuna.trial.TrialState.RUNNING for item in study.get_trials(deepcopy=False)):
            raise ValidationError("Tell the running Optuna trial before asking again")
        trial = study.ask(fixed_distributions=distributions)
        checkpoint = self._seal(study, configuration)
        return {"kind": "result", "value": {"trialNumber": trial.number, "params": trial.params,
                                             "checkpointRef": checkpoint}}


class OptunaTellProvider(_CheckpointProvider):
    def __init__(self, *, checkpoint_key: bytes, record_dir: str | None = None,
                 artifacts: ArtifactClient | None = None) -> None:
        super().__init__("optuna.tell", _TELL_INPUT, _TELL_OUTPUT, checkpoint_key=checkpoint_key,
                         record_dir=record_dir, artifacts=artifacts)

    def preflight(self, request: dict[str, Any]) -> dict[str, Any]:
        checked = super().preflight(request)
        value = request["input"]
        study, _ = self._load(value["checkpointRef"])
        number = value["trialNumber"]
        if number < 0 or number >= len(study.trials) or study.trials[number].state != _optuna().trial.TrialState.RUNNING:
            raise ValidationError("Optuna tell needs the checkpoint's running trial")
        if value["state"] == "COMPLETE":
            score = value.get("value")
            if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
                raise ValidationError("Complete Optuna trial needs a finite value")
        elif "value" in value:
            raise ValidationError("Failed/pruned Optuna trial cannot carry a value")
        return checked

    def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        optuna = _optuna()
        value = request["input"]
        study, configuration = self._load(value["checkpointRef"])
        number = value["trialNumber"]
        if not isinstance(number, int) or number < 0:
            raise ValidationError("Optuna trial number must be nonnegative")
        state = value["state"]
        if state == "COMPLETE":
            score = value.get("value")
            if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
                raise ValidationError("Complete Optuna trial needs a finite value")
            frozen = study.tell(number, float(score), state=optuna.trial.TrialState.COMPLETE)
        else:
            if "value" in value:
                raise ValidationError("Failed/pruned Optuna trial cannot carry a value")
            frozen = study.tell(number, state=getattr(optuna.trial.TrialState, state))
        checkpoint = self._seal(study, configuration)
        result: dict[str, Any] = {"checkpointRef": checkpoint, "trialNumber": frozen.number,
                                  "state": frozen.state.name}
        completed = [item for item in study.get_trials(deepcopy=False)
                     if item.state == optuna.trial.TrialState.COMPLETE]
        if completed:
            result["bestValue"] = study.best_value
        return {"kind": "result", "value": result}
