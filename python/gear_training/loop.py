"""A fixed, durable four-stage loop for ordinary Python implementations.

Stages may return JSON values directly or awaitables. ModelUpdater returns the
next JSON checkpoint, including any optimizer/RNG state the application needs.
A successful stage is replayed from its sealed result. If an external update
happens before its result is persisted, recovery calls update again with the
same operation_id: the updater must make that operation idempotent itself.

Stage identity defaults to its class's module/qualified name. It does not
fingerprint source code or instance attributes. Set stage_id (e.g. "updater:v2")
and/or change config.parameters when implementation or settings change. A
changed identity requires a new workspace; it cannot reinterpret old results.
JSON identities/digests are checked on replay, not bytes referenced by file
paths inside a checkpoint. Backends must seal/verify their checkpoint files.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import uuid
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Protocol, Union

from .content import ContractError, require, sync_dir
from .state import lock

_MISSING = object()
JSONValue = Any
StageValue = Union[JSONValue, Awaitable[JSONValue]]


@dataclass(frozen=True)
class TrainingConfig:
    workspace: str | Path
    rounds: int
    initial_checkpoint: JSONValue = None
    parameters: dict[str, JSONValue] = field(default_factory=dict)


@dataclass(frozen=True)
class TrainingContext:
    round_index: int
    checkpoint: JSONValue
    history: list[dict[str, JSONValue]]
    operation_id: str
    workspace: Path
    run_workspace: Path
    config: TrainingConfig


@dataclass(frozen=True)
class TrainingResult:
    checkpoint: JSONValue
    history: list[dict[str, JSONValue]]
    rounds_completed: int
    workspace: Path


class TaskSource(Protocol):
    def generate(self, ctx: TrainingContext) -> StageValue: ...


class RolloutExecutor(Protocol):
    def execute(self, ctx: TrainingContext, tasks: JSONValue) -> StageValue: ...


class DatasetBuilder(Protocol):
    def build(self, ctx: TrainingContext, trajectories: JSONValue) -> StageValue: ...


class ModelUpdater(Protocol):
    def update(self, ctx: TrainingContext, dataset: JSONValue) -> StageValue: ...


def _bytes(value):
    def validate(item):
        if item is None or type(item) in (str, bool, int, float): return
        if type(item) is list:
            for child in item: validate(child)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values(): validate(child)
            return
        raise ContractError("non-json-stage-value", "configuration, checkpoints and stage results must be JSON values")
    validate(value)
    try: return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, OverflowError) as error: raise ContractError("non-json-stage-value", str(error)) from error


def _copy(value): return json.loads(_bytes(value))
def _digest(value): return "sha256:" + hashlib.sha256(_bytes(value)).hexdigest()


def _write(path, value):
    """Atomic, fsynced JSON, including ordinary Unicode application keys."""
    data = _bytes(value)
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(data + b"\n"); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path); sync_dir(path.parent)
    finally: temporary.unlink(missing_ok=True)


def _read(path):
    try:
        value = json.loads(Path(path).read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        require(isinstance(value, dict), "corrupt-training-artifact", str(path) + " must contain an object")
        return value
    except FileNotFoundError: return _MISSING
    except ContractError: raise
    except (ValueError, UnicodeError) as error: raise ContractError("corrupt-training-artifact", str(path)) from error


class TrainingLoop:
    """Run four plain objects in order; resume completed stages in workspace.

    ``run(config)`` is synchronous. Use ``await arun(config)`` from an active
    event loop. Both support mixtures of synchronous and asynchronous methods.
    Every stage gets its own fixed directory via ctx.workspace, and private
    deep copies of inputs/checkpoint/history. Returned objects must be JSON.
    """
    def __init__(self, task_source: TaskSource, rollout_executor: RolloutExecutor,
                 dataset_builder: DatasetBuilder, model_updater: ModelUpdater):
        self.stages = (("task-source", task_source, "generate"),
                       ("rollout-executor", rollout_executor, "execute"),
                       ("dataset-builder", dataset_builder, "build"),
                       ("model-updater", model_updater, "update"))
        for name, stage, method in self.stages:
            require(callable(getattr(stage, method, None)), "invalid-training-stage", name + " requires " + method)

    def run(self, config: TrainingConfig | dict) -> TrainingResult:
        try: asyncio.get_running_loop()
        except RuntimeError: return asyncio.run(self.arun(config))
        raise ContractError("training-event-loop-active", "use await TrainingLoop.arun(config) in an active event loop")

    async def arun(self, config: TrainingConfig | dict) -> TrainingResult:
        if isinstance(config, dict): config = TrainingConfig(**config)
        require(isinstance(config, TrainingConfig) and type(config.rounds) is int and config.rounds > 0
                and type(config.parameters) is dict, "invalid-training-config", "positive rounds and JSON parameters are required")
        parameters, initial = _copy(config.parameters), _copy(config.initial_checkpoint)
        workspace = Path(config.workspace).resolve()
        config = TrainingConfig(workspace, config.rounds, initial, parameters)
        stage_ids = {}
        for name, stage, _ in self.stages:
            identity = getattr(stage, "stage_id", type(stage).__module__ + "." + type(stage).__qualname__)
            require(isinstance(identity, str) and bool(identity), "invalid-stage-identity", "stage_id must be a nonempty versioned string")
            stage_ids[name] = identity
        configuration = {"schemaVersion": 1, "kind": "training-loop", "rounds": config.rounds,
                         "initialCheckpoint": initial, "parameters": parameters, "stages": stage_ids}
        with ExitStack() as stack:
            try: stack.enter_context(lock(workspace / ".training-loop.lock", blocking=False))
            except BlockingIOError as error: raise ContractError("training-workspace-busy", "another loop owns this workspace") from error
            previous = _read(workspace / "identity.json")
            if previous is _MISSING:
                require(not (workspace / "result.json").exists() and not any((workspace / "rounds").glob("*/*/result.json")) and not any((workspace / "rounds").glob("*/*/input.json")),
                        "training-artifact-missing", "persisted run identity is missing from an existing loop")
                identity = {**configuration, "runId": uuid.uuid4().hex}
                _write(workspace / "identity.json", identity)
            else:
                require(set(previous) == {*configuration, "runId"} and isinstance(previous.get("runId"), str)
                        and len(previous["runId"]) == 32 and all(character in "0123456789abcdef" for character in previous["runId"])
                        and {key: value for key, value in previous.items() if key != "runId"} == configuration,
                        "training-config-drift", "workspace belongs to another configuration or stage identity")
                identity = previous
            run_digest = _digest(identity)
            completed_record = _read(workspace / "result.json")
            missing = False
            for index in range(config.rounds):
                for name, _, _ in self.stages:
                    directory = workspace / "rounds" / f"{index:06d}" / name
                    exists = (directory / "result.json").exists()
                    require(not (missing and (exists or (directory / "input.json").exists())), "training-artifact-missing", "stage results must form a continuous prefix; a successful earlier result is missing")
                    missing = missing or not exists
            require(completed_record is _MISSING or not missing, "training-artifact-missing", "completed loop is missing a successful stage result")
            checkpoint, history = initial, []
            history_digest = _digest([])
            for index in range(config.rounds):
                outputs = []
                for name, stage, method in self.stages:
                    arguments = [] if not outputs else [outputs[-1]]
                    inputs = {"schemaVersion": 1, "runDigest": run_digest, "roundIndex": index, "stage": name,
                              "checkpointDigest": _digest(checkpoint), "historyDigest": history_digest,
                              "parametersDigest": _digest(parameters), "argumentsDigest": _digest(arguments)}
                    input_digest = _digest(inputs)
                    operation_id = _digest({"runDigest": run_digest, "roundIndex": index, "stage": name, "inputDigest": input_digest})
                    directory = workspace / "rounds" / f"{index:06d}" / name
                    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                    stage_workspace = directory / "workspace"
                    stage_workspace.mkdir(exist_ok=True, mode=0o700)
                    input_record = {"schemaVersion": 1, "inputDigest": input_digest, "inputs": inputs}
                    saved_input = _read(directory / "input.json")
                    require(saved_input is _MISSING or saved_input == input_record, "training-input-drift", "persisted stage inputs changed")
                    if saved_input is _MISSING: _write(directory / "input.json", input_record)
                    record = _read(directory / "result.json")
                    if record is not _MISSING:
                        require(isinstance(record, dict) and set(record) == {"schemaVersion", "stage", "roundIndex", "operationId", "inputDigest", "outputDigest", "output"}
                                and record["schemaVersion"] == 1 and record["stage"] == name and record["roundIndex"] == index
                                and record["operationId"] == operation_id and record["inputDigest"] == input_digest
                                and record["outputDigest"] == _digest(record["output"]),
                                "training-result-drift", "persisted stage result failed its identity or digest")
                        output = _copy(record["output"])
                    else:
                        context = TrainingContext(index, _copy(checkpoint), _copy(history), operation_id, stage_workspace, workspace,
                                                  TrainingConfig(workspace, config.rounds, _copy(initial), _copy(parameters)))
                        output = getattr(stage, method)(context, *_copy(arguments))
                        if inspect.isawaitable(output): output = await output
                        output = _copy(output)
                        require(name != "model-updater" or output is not None, "missing-training-checkpoint", "ModelUpdater.update must return a JSON checkpoint")
                        _write(directory / "result.json", {"schemaVersion": 1, "stage": name, "roundIndex": index,
                               "operationId": operation_id, "inputDigest": input_digest, "outputDigest": _digest(output), "output": output})
                    require(name != "model-updater" or output is not None, "missing-training-checkpoint", "ModelUpdater.update must return a JSON checkpoint")
                    outputs.append(output)
                history_digest = _digest({"previous": history_digest, "roundIndex": index, "outputs": [_digest(output) for output in outputs]})
                checkpoint = outputs[-1]
                history.append({"round_index": index, "tasks": outputs[0], "trajectories": outputs[1],
                                "dataset": outputs[2], "checkpoint": checkpoint, "operation_id": operation_id})
            result = TrainingResult(_copy(checkpoint), _copy(history), len(history), workspace)
            final_record = {"schemaVersion": 1, "runDigest": run_digest, "checkpoint": result.checkpoint,
                            "history": result.history, "roundsCompleted": result.rounds_completed}
            require(completed_record is _MISSING or completed_record == final_record, "training-result-drift", "completed loop record differs from its verified stages")
            if completed_record is _MISSING: _write(workspace / "result.json", final_record)
            return result
