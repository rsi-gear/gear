"""A0 author replay driver. All managed effects are intents, never run here.

Each replay constructs a fresh coroutine tree from frozen input and terminal
history. Suspended coroutines are closed after planning, so ``finally`` is only
for local cleanup; provider cancellation/release belongs to the Campaign.
Only managed awaits can suspend safely. Static checks cover known direct IO and
concurrency patterns, but this is not a sandbox for arbitrary async or hidden
third-party IO. The host enforces a process timeout for non-yielding code.
"""
from __future__ import annotations

import ast
from contextvars import ContextVar
import copy
from dataclasses import dataclass, field
from decimal import Decimal
import hashlib
import inspect
import json
from pathlib import Path
import re
import sys
import textwrap
import traceback
import types
from typing import Any, Callable, Mapping

from gear_algorithm.errors import GearAlgorithmError
from gear_algorithm.protocol import assert_schema, json_safe_integer, validate_json, validate_schema
from gear_algorithm.author.dto import (
    ArtifactRef, AuthorCapabilitiesV1, EvaluationV1, HarnessAgentV1,
    ProposalBatchV1, RoleResultV1, TaskSelectionV1,
    assert_artifact_ref, assert_author_capabilities_v1, assert_harness_agent_v1,
    assert_task_selection_v1, decode_role_execution_result,
)


WIRE_VERSION = "gear.author.replay.v1"
WIRE_VERSION_V2 = "gear.author.replay.v2"
CAPABILITIES_VERSION = "gear.author.capabilities.v1"
MAX_FRAME_BYTES = 1024 * 1024
_active_task: ContextVar[_Task | None] = ContextVar("gear_author_task", default=None)


class AuthorError(GearAlgorithmError):
    """A definition, replay, or author usage error with source location."""

    def __init__(self, code: str, message: str, path: str = "$") -> None:
        super().__init__(code, message, path)
        # Construction/usage errors must remain fatal even when author code
        # catches the Python exception and attempts a different frontier.
        task = _active_task.get()
        if task is not None and task.fatal is None:
            task.fatal = self


class OperationFailure(Exception):
    """A sealed business failure; safe for sequential author code to catch."""

    def __init__(self, outcome: Mapping[str, Any]) -> None:
        self.outcome = dict(outcome)
        super().__init__(str(outcome.get("message") or outcome.get("reason") or outcome["kind"]))


def _site(depth: int = 2) -> str:
    frame = sys._getframe(depth)
    return f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno}"


def _snapshot(value: Any, path: str = "$") -> Any:
    if isinstance(value, _FrozenMap):
        value = value.to_json()
    if isinstance(value, tuple):
        value = list(value)
    validate_json(value, path)
    return copy.deepcopy(value)


def _v2_wire_numbers(value: Any) -> Any:
    """Match JSON.parse's number domain before v2 author code sees a value."""
    if type(value) is float:
        integer = json_safe_integer(value)
        return integer if integer is not None else value
    if isinstance(value, list):
        return [_v2_wire_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _v2_wire_numbers(item) for key, item in value.items()}
    return value


class _FrozenMap(Mapping[str, Any]):
    __slots__ = ("_data",)

    def __init__(self, value: Mapping[str, Any]) -> None:
        object.__setattr__(self, "_data", types.MappingProxyType(
            {key: _readonly(item) for key, item in value.items()}))

    def __setattr__(self, _name: str, _value: Any) -> None:
        raise TypeError("author input is read-only")

    def __delattr__(self, _name: str) -> None:
        raise TypeError("author input is read-only")

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __iter__(self):
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def __getattr__(self, name: str) -> Any:
        try:
            return self._data[name]
        except KeyError:
            camel = re.sub(r"_([a-z])", lambda match: match[1].upper(), name)
            try:
                return self._data[camel]
            except KeyError as exc:
                raise AttributeError(name) from exc

    def to_json(self) -> dict[str, Any]:
        return {key: _plain(value) for key, value in self._data.items()}


class OutcomeView(dict):
    """Read-only JSON dict with attribute access for a collected branch."""
    __slots__ = ()

    def __init__(self, value: Mapping[str, Any]) -> None:
        dict.__init__(self)
        for key, item in value.items():
            dict.__setitem__(self, key, _readonly(item))

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, _name: str, _value: Any) -> None:
        raise TypeError("collected outcome is read-only")

    def __delattr__(self, _name: str) -> None:
        raise TypeError("collected outcome is read-only")

    def __setitem__(self, _key: str, _value: Any) -> None:
        raise TypeError("collected outcome is read-only")

    def __delitem__(self, _key: str) -> None:
        raise TypeError("collected outcome is read-only")

    def clear(self) -> None:
        raise TypeError("collected outcome is read-only")

    def pop(self, _key: str, _default: Any = None) -> Any:
        raise TypeError("collected outcome is read-only")

    def popitem(self) -> Any:
        raise TypeError("collected outcome is read-only")

    def setdefault(self, _key: str, _default: Any = None) -> Any:
        raise TypeError("collected outcome is read-only")

    def update(self, *_args: Any, **_kwargs: Any) -> None:
        raise TypeError("collected outcome is read-only")

    def __ior__(self, _other: Any):
        raise TypeError("collected outcome is read-only")


def _readonly(value: Any) -> Any:
    if isinstance(value, dict):
        return _FrozenMap(value)
    if isinstance(value, (list, tuple)):
        return tuple(_readonly(item) for item in value)
    return value


def _plain(value: Any) -> Any:
    if isinstance(value, _FrozenMap):
        return value.to_json()
    if isinstance(value, tuple):
        return [_plain(item) for item in value]
    if isinstance(value, list):
        return [_plain(item) for item in value]
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    return value


def _json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_json(value: Any) -> str:
    """Canonical JSON matching Gear's TypeScript canonicalJson for valid JSON.

    Python repr supplies the shortest round-trip decimal digits; Decimal only
    chooses the JavaScript fixed/scientific display threshold for those digits.
    """
    value = _plain(value)
    validate_json(value)
    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, str):
            return _json_string(item)
        if isinstance(item, int):
            return str(item)
        if isinstance(item, float):
            if item == 0:
                return "0"  # JSON.stringify(-0) is 0.
            number = Decimal(repr(item))
            exponent = number.adjusted()
            if -6 <= exponent < 21:
                fixed = format(number, "f")
                return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
            mantissa, power = format(number.normalize(), "e").split("e")
            power_value = int(power)
            suffix = f"+{power_value}" if power_value >= 0 else str(power_value)
            return f"{mantissa}e{suffix}"
        if isinstance(item, list):
            return "[" + ",".join(encode(child) for child in item) + "]"
        return "{" + ",".join(_json_string(key) + ":" + encode(item[key])
                            for key in sorted(item, key=lambda key: key.encode("utf-8"))) + "}"
    return encode(value)


def input_digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _cell(value: Any):
    def capture():
        return value
    return capture.__closure__[0]


def _copy_function(function: Callable[..., Any]) -> Callable[..., Any]:
    """Snapshot JSON captures and global data; use a fresh immutable view per call."""
    def frozen_default(value: Any, label: str) -> Any:
        try:
            return _readonly(_snapshot(_plain(value), label))
        except GearAlgorithmError as exc:
            raise AuthorError("AUTHOR_CAPTURE", f"unsupported mutable default {label}; pass JSON data explicitly",
                              f"{Path(function.__code__.co_filename).name}:{function.__code__.co_firstlineno}") from exc
    closure = function.__closure__
    cells = None
    if closure:
        values = []
        for name, cell in zip(function.__code__.co_freevars, closure):
            captured = cell.cell_contents
            if isinstance(captured, (dict, list, tuple, _FrozenMap, str, int, float, bool)) or captured is None:
                captured = _readonly(_snapshot(_plain(captured), f"capture.{name}"))
            elif not isinstance(captured, WorkflowDefinition) and not inspect.isfunction(captured) and not inspect.ismodule(captured):
                raise AuthorError("AUTHOR_CAPTURE", f"unsupported capture {name}; pass JSON data as an argument",
                                  f"{Path(function.__code__.co_filename).name}:{function.__code__.co_firstlineno}")
            values.append(_cell(captured))
        cells = tuple(values)
    globals_snapshot = function.__globals__.copy()
    for name in function.__code__.co_names:
        if name in globals_snapshot and isinstance(globals_snapshot[name], (dict, list, tuple, _FrozenMap)):
            globals_snapshot[name] = _readonly(_snapshot(_plain(globals_snapshot[name]), f"global.{name}"))
    defaults = (tuple(frozen_default(value, f"default.{index}") for index, value in enumerate(function.__defaults__))
                if function.__defaults__ is not None else None)
    clone = types.FunctionType(function.__code__, globals_snapshot, function.__name__, defaults, cells)
    clone.__kwdefaults__ = ({key: frozen_default(value, f"kwdefault.{key}")
                             for key, value in function.__kwdefaults__.items()}
                            if function.__kwdefaults__ is not None else None)
    return clone


def _check_known_unsafe_calls(function: Callable[..., Any]) -> None:
    try:
        source, source_line = inspect.getsourcelines(function)
        source = "".join(source)
        tree = ast.parse(textwrap.dedent(source))
    except (OSError, TypeError, SyntaxError):
        return
    banned = {"open": "use a frozen input ref", "time.time": "await ctx.now()",
              "time.monotonic": "await ctx.now()", "random.random": "await ctx.random_seed()",
              "random.randint": "await ctx.random_seed()", "random.choice": "await ctx.random_seed()",
              "asyncio.gather": "await ctx.parallel()", "asyncio.create_task": "await ctx.parallel()",
              "requests.get": "ctx.operation()", "requests.post": "ctx.operation()",
              "httpx.get": "ctx.operation()", "httpx.post": "ctx.operation()",
              "subprocess.run": "ctx.operation()", "subprocess.Popen": "ctx.operation()"}
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                aliases[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    def name_of(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return name_of(node.value) + "." + node.attr
        return ""
    def resolved(name: str) -> str:
        first, _, rest = name.partition(".")
        return aliases.get(first, first) + ("." + rest if rest else "")
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = resolved(name_of(node.func))
            alternative = banned.get(name)
            if alternative is None and isinstance(node.func, ast.Attribute) and node.func.attr in (
                    "open", "read_text", "read_bytes", "write_text", "write_bytes"):
                alternative = "use a frozen input ref or ctx.operation()"
            if alternative is None and name.startswith(("openai.", "boto3.", "urllib.request.")):
                alternative = "ctx.operation()"
            if alternative is not None:
                line = source_line + node.lineno - 1
                raise AuthorError("AUTHOR_UNMANAGED_IO", f"{name} is unmanaged; {alternative}",
                                  f"{Path(function.__code__.co_filename).name}:{line}")
        if isinstance(node, ast.Attribute) and resolved(name_of(node)) == "os.environ":
            line = source_line + node.lineno - 1
            raise AuthorError("AUTHOR_UNMANAGED_IO", "os.environ is mutable; use frozen config",
                              f"{Path(function.__code__.co_filename).name}:{line}")


class ManagedCall:
    def __init__(self, call_type: str, payload: Any, *, definition: WorkflowDefinition | None = None,
                 children: tuple[ManagedCall, ...] = (), decoder: Callable[[Any], Any] | None = None) -> None:
        task = _active_task.get()
        if task is None:
            raise AuthorError("AUTHOR_SCOPE", "ManagedCall must be created during an algorithm replay", _site(2))
        if task.closing:
            raise AuthorError("AUTHOR_FINALLY_EFFECT", "finally cleanup cannot create a ManagedCall", _site(3))
        self.call_type = call_type
        self.payload = payload
        self.definition = definition
        self.children = children
        self.decoder = decoder
        self.owner = task
        self.ordinal = task.next_ordinal
        task.next_ordinal += 1
        task.created.append(self)
        self.site = _site(3)
        self.used = False
        self.transfer_to: _Task | None = None

    def __await__(self):
        result = yield self
        return result


class WorkflowDefinition:
    def __init__(self, function: Callable[..., Any], *, root: bool = False,
                 version: str = "v1", config_schema: Mapping[str, Any] | None = None) -> None:
        if not inspect.iscoroutinefunction(function):
            raise AuthorError("AUTHOR_DEFINITION", "workflow must be async", _site(3))
        if not isinstance(version, str) or not version:
            raise AuthorError("AUTHOR_DEFINITION", "definition version must be a nonempty string", _site(3))
        if root and version != "v1":
            raise AuthorError("AUTHOR_DEFINITION", "root version is fixed at algorithm.v1; freeze source identity in the host", _site(3))
        if config_schema is not None and not root:
            raise AuthorError("AUTHOR_DEFINITION", "only @algorithm declares config_schema", _site(3))
        if config_schema is not None:
            assert_schema(config_schema)
        _check_known_unsafe_calls(function)
        self.function = _copy_function(function)
        self.root = root
        self.version = version
        self.name = function.__name__
        self.site = f"{Path(function.__code__.co_filename).name}:{function.__code__.co_firstlineno}"
        self.config_schema = _snapshot(dict(config_schema), "$.configSchema") if config_schema is not None else None

    def describe(self) -> dict[str, Any]:
        if not self.root:
            raise AuthorError("AUTHOR_DEFINITION", "only @algorithm is a worker export", self.site)
        result = {"apiVersion": WIRE_VERSION, "id": self.name,
                  "definitionVersion": "algorithm.v1"}
        if self.config_schema is not None:
            result["configSchema"] = copy.deepcopy(self.config_schema)
        return result

    def __call__(self, *args: Any, **kwargs: Any) -> ManagedCall:
        if self.root:
            raise AuthorError("AUTHOR_SCOPE", "algorithm is an entry point, not a child call", self.site)
        frozen_args = _snapshot(list(args), "$.args")
        frozen_kwargs = _snapshot(kwargs, "$.kwargs")
        return ManagedCall("workflow", {"args": frozen_args, "kwargs": frozen_kwargs}, definition=self)


def workflow(function: Callable[..., Any] | None = None, *, version: str = "v1"):
    if function is None:
        return lambda actual: WorkflowDefinition(actual, version=version)
    return WorkflowDefinition(function, version=version)


def algorithm(function: Callable[..., Any] | None = None, *, version: str = "v1",
              config_schema: Mapping[str, Any] | None = None):
    if function is None:
        return lambda actual: WorkflowDefinition(actual, root=True, version=version,
                                                 config_schema=config_schema)
    return WorkflowDefinition(function, root=True, version=version, config_schema=config_schema)


def _check_capabilities(value: Any) -> None:
    try:
        assert_author_capabilities_v1(value)
    except GearAlgorithmError as exc:
        raise AuthorError("AUTHOR_CAPABILITIES", str(exc)) from exc


class TaskTools:
    def __init__(self, context: AuthorContext) -> None:
        self._context = context

    def sample(self, source_task_view_ref: Any, *, count: int, seed: int) -> ManagedCall:
        if self._context.wire_version != WIRE_VERSION_V2:
            raise AuthorError("AUTHOR_CAPABILITY", "tasks.sample requires author capabilities v1", _site(2))
        ref = _plain(source_task_view_ref)
        try:
            assert_artifact_ref(ref, schema_id="task.view.v1")
        except GearAlgorithmError as exc:
            raise AuthorError("AUTHOR_INPUT", "tasks.sample needs a TaskViewRef", _site(2)) from exc
        count_value = json_safe_integer(count)
        if count_value is None or count_value < 1:
            raise AuthorError("AUTHOR_INPUT", "tasks.sample count must be a positive safe integer", _site(2))
        seed_value = json_safe_integer(seed)
        if seed_value is None:
            raise AuthorError("AUTHOR_INPUT", "tasks.sample seed must be a safe integer", _site(2))
        def decode(value: Any) -> Any:
            assert_task_selection_v1(value)
            if len(value["selectedTaskIds"]) != count_value:
                raise AuthorError("AUTHOR_RESULT", "tasks.sample returned a different count", _site(2))
            return value
        return self._context.operation("tasks.sample", {"sourceTaskViewRef": ref, "count": count_value, "seed": seed_value},
                                       limits={}, starts_budget_clock=False, _decoder=decode)


class AuthorContext:
    def __init__(self, input_value: Mapping[str, Any], wire_version: str) -> None:
        self.wire_version = wire_version
        def frozen(name: str) -> Any:
            value = _snapshot(input_value[name], f"$.input.{name}")
            return _readonly(_v2_wire_numbers(value) if wire_version == WIRE_VERSION_V2 else value)
        self.initial_agent = frozen("initialAgent")
        self.data = frozen("data")
        self.config = frozen("config")
        self.capabilities = (frozen("capabilities")
                             if wire_version == WIRE_VERSION_V2 else None)
        self.tasks = TaskTools(self)

    def operation(self, kind: str, input: Any, *, binding_set_ref: Any = None,
                  limits: Any = None, starts_budget_clock: bool | None = None,
                  _decoder: Callable[[Any], Any] | None = None) -> ManagedCall:
        if not isinstance(kind, str) or not kind:
            raise AuthorError("AUTHOR_INPUT", "operation kind must be nonempty", _site(2))
        if self.wire_version == WIRE_VERSION_V2 and kind in (
                "author.role", "author.edit", "author.rollout", "author.measure"):
            raise AuthorError("AUTHOR_CAPABILITY", f"A0 fake kind {kind} is unavailable in v2", _site(2))
        payload: dict[str, Any] = {"kind": kind, "input": _snapshot(_plain(input), "$.operation.input")}
        if binding_set_ref is not None:
            payload["bindingSetRef"] = _snapshot(_plain(binding_set_ref))
        if limits is not None:
            payload["limits"] = _snapshot(_plain(limits))
        if starts_budget_clock is not None:
            if type(starts_budget_clock) is not bool:
                raise AuthorError("AUTHOR_INPUT", "starts_budget_clock must be boolean", _site(2))
            payload["startsBudgetClock"] = starts_budget_clock
        return ManagedCall("operation", payload, decoder=_decoder)

    def parallel(self, calls: list[ManagedCall] | tuple[ManagedCall, ...]) -> ManagedCall:
        if not isinstance(calls, (list, tuple)):
            raise AuthorError("AUTHOR_PARALLEL", "parallel requires an ordered list of ManagedCall values", _site(2))
        owner = _active_task.get()
        for call in calls:
            if not isinstance(call, ManagedCall) or call.owner is not owner or call.used:
                raise AuthorError("AUTHOR_SCOPE", "parallel child must be a fresh call in this scope", _site(2))
        if len({id(call) for call in calls}) != len(calls):
            raise AuthorError("AUTHOR_REUSED_CALL", "same ManagedCall occurs twice in parallel", _site(2))
        return ManagedCall("parallel", {}, children=tuple(calls))

    def checkpoint(self, name: str, value: Any, *, schema: str = "author.archive.v1") -> ManagedCall:
        if not isinstance(name, str) or not name:
            raise AuthorError("AUTHOR_INPUT", "checkpoint name must be nonempty", _site(2))
        return self.operation("author.checkpoint", {"name": name, "value": _plain(value), "schema": schema})

    def _observe(self, kind: str) -> ManagedCall:
        return self.operation("author.observe", {"kind": kind})

    def now(self) -> ManagedCall:
        return self._observe("now")

    def budget(self) -> ManagedCall:
        return self._observe("budget")

    def random_seed(self) -> ManagedCall:
        return self._observe("random-seed")

    def new_id(self) -> ManagedCall:
        return self._observe("id")

    def role(self, name: str, input: Any) -> ManagedCall:
        if not isinstance(name, str) or not name:
            raise AuthorError("AUTHOR_INPUT", "role name must be nonempty", _site(2))
        if self.wire_version == WIRE_VERSION_V2:
            grant = self.capabilities.roles.get(name)
            if grant is None or grant.kind != "execution.role" or grant.template != "read-only-analyst":
                raise AuthorError("AUTHOR_CAPABILITY", f"role {name} lacks read-only execution.role grant", _site(2))
            limits = _plain(self.capabilities.operation_limits.get("execution.role", {}))
            binding_digest = self.initial_agent.binding_set_ref.digest
            return self.operation("execution.role", {"roleId": name, "input": _plain(input)},
                                  binding_set_ref=_plain(self.initial_agent.binding_set_ref), limits=limits,
                                  _decoder=lambda value: decode_role_execution_result(value, binding_digest))
        return self.operation("author.role", {"name": name, "input": _plain(input)})

    def edit(self, input: Any) -> ManagedCall:
        return self.operation("author.edit", _plain(input))

    def rollout(self, input: Any) -> ManagedCall:
        return self.operation("author.rollout", _plain(input))

    def measure(self, input: Any) -> ManagedCall:
        return self.operation("author.measure", _plain(input))

    def result(self, *, selected: Any = None, outputs: Any = None) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if selected is not None:
            result["selected"] = _snapshot(_plain(selected))
            if self.wire_version == WIRE_VERSION_V2:
                try:
                    assert_harness_agent_v1(result["selected"])
                except GearAlgorithmError as exc:
                    raise AuthorError("AUTHOR_RESULT", "selected must be HarnessAgentV1", _site(2)) from exc
        if outputs is not None:
            result["outputs"] = _snapshot(_plain(outputs))
        return result


@dataclass
class _Task:
    coroutine: Any
    scope: str
    definition_version: str
    next_ordinal: int = 0
    created: list[ManagedCall] = field(default_factory=list)
    done: bool = False
    value: Any = None
    failure: BaseException | None = None
    fatal: AuthorError | None = None
    waiting: bool = False
    closing: bool = False


class _Driver:
    def __init__(self, definition: WorkflowDefinition, request: Mapping[str, Any]) -> None:
        self.definition = definition
        self.request = request
        self.history: dict[str, Mapping[str, Any]] = {}
        self.used_history: set[str] = set()
        self.frontier: list[dict[str, Any]] = []
        self.context = AuthorContext(request["input"], request["version"])
        self.tasks: list[_Task] = []
        for entry in request["history"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("address"), str):
                raise AuthorError("AUTHOR_HISTORY", "history entry requires address")
            if entry["address"] in self.history:
                raise AuthorError("AUTHOR_HISTORY", "duplicate history address", entry["address"])
            outcome = entry.get("outcome")
            if not isinstance(outcome, dict) or outcome.get("kind") not in (
                    "result", "error", "no-result", "inconclusive", "cancelled"):
                raise AuthorError("AUTHOR_HISTORY", "history requires a terminal outcome", entry["address"])
            self.history[entry["address"]] = entry

    def _assert_consumed(self, task: _Task) -> None:
        for call in task.created:
            if not call.used:
                raise AuthorError("AUTHOR_UNUSED_CALL", "created ManagedCall was never awaited", call.site)

    @staticmethod
    def _task_site(task: _Task) -> str:
        frame = getattr(task.coroutine, "cr_frame", None)
        if frame is None:
            return task.scope
        return f"{Path(frame.f_code.co_filename).name}:{frame.f_lineno}"

    def _run(self, task: _Task, *, value: Any = None, failure: BaseException | None = None) -> None:
        while True:
            token = _active_task.set(task)
            try:
                yielded = task.coroutine.throw(failure) if failure is not None else task.coroutine.send(value)
            except StopIteration as stop:
                if task.fatal is not None:
                    raise task.fatal
                self._assert_consumed(task)
                task.done = True
                task.value = stop.value
                return
            except OperationFailure as exc:
                self._assert_consumed(task)
                task.done = True
                task.failure = exc
                return
            except AuthorError:
                raise
            except BaseException as exc:
                frames = traceback.extract_tb(exc.__traceback__)
                site = f"{Path(frames[-1].filename).name}:{frames[-1].lineno}" if frames else self._task_site(task)
                raise AuthorError("AUTHOR_EXECUTION", type(exc).__name__, site) from exc
            finally:
                _active_task.reset(token)
            if task.fatal is not None:
                raise task.fatal
            value, failure = None, None
            if not isinstance(yielded, ManagedCall):
                raise AuthorError("AUTHOR_UNMANAGED_AWAIT", "only ManagedCall may be awaited", self._task_site(task))
            call = yielded
            if call.used:
                raise AuthorError("AUTHOR_REUSED_CALL", "ManagedCall consumed twice", call.site)
            if call.owner is not task and call.transfer_to is not task:
                raise AuthorError("AUTHOR_SCOPE", "ManagedCall used outside its creation scope", call.site)
            call.used = True
            ordinal = 0 if call.transfer_to is task else call.ordinal
            address = f"{task.scope}/s{ordinal}"
            if call.call_type == "operation":
                intent = {"address": address, "definitionVersion": task.definition_version, **call.payload}
                digest_input = {key: val for key, val in intent.items()
                                if key not in ("address", "kind", "definitionVersion")}
                digest = input_digest(digest_input)
                old = self.history.get(address)
                if old is None:
                    self.frontier.append(intent)
                    task.waiting = True
                    return
                self.used_history.add(address)
                if (old.get("kind") != intent["kind"] or old.get("inputDigest") != digest
                        or old.get("definitionVersion") != task.definition_version):
                    raise AuthorError("AUTHOR_INPUT_DRIFT", "history definition, kind or input changed", address)
                outcome = old["outcome"]
                if outcome["kind"] == "result":
                    value = outcome.get("value")
                    if call.decoder is not None:
                        try:
                            value = call.decoder(value)
                        except GearAlgorithmError as exc:
                            raise AuthorError("AUTHOR_RESULT", f"managed result invalid: {exc}", call.site) from exc
                    value = _snapshot(value)
                    value = _readonly(_v2_wire_numbers(value) if self.request["version"] == WIRE_VERSION_V2 else value)
                else:
                    failure = OperationFailure(outcome)
                continue
            if call.call_type == "workflow":
                child = self._workflow_task(call.definition, call.payload, address,
                                            task.definition_version)
                self._run(child)
                if child.done:
                    value, failure = child.value, child.failure
                    continue
                task.waiting = True
                return
            if call.call_type == "parallel":
                outcomes: list[dict[str, Any]] = []
                pending = False
                for index, item in enumerate(call.children):
                    async def invoke(child_call: ManagedCall):
                        return await child_call
                    child = _Task(invoke(item), f"{address}/p{index}", task.definition_version)
                    self.tasks.append(child)
                    item.transfer_to = child
                    self._run(child)
                    if child.done:
                        if child.failure is None:
                            outcomes.append({"ok": True, "value": _plain(child.value)})
                        elif isinstance(child.failure, OperationFailure):
                            outcomes.append({"ok": False, "error": dict(child.failure.outcome)})
                        else:
                            raise child.failure
                    else:
                        pending = True
                if pending:
                    task.waiting = True
                    return
                value = [OutcomeView(item) for item in outcomes]
                continue
            raise AuthorError("AUTHOR_PROTOCOL", "invalid ManagedCall type", call.site)

    def _workflow_task(self, definition: WorkflowDefinition, payload: Mapping[str, Any],
                       address: str, parent_version: str | None = None) -> _Task:
        function = _copy_function(definition.function)
        args = [_readonly(copy.deepcopy(arg)) for arg in payload["args"]]
        kwargs = {key: _readonly(copy.deepcopy(val)) for key, val in payload["kwargs"].items()}
        version = (f"{parent_version}/{definition.name}@{definition.version}" if parent_version
                   else "algorithm.v2" if self.request["version"] == WIRE_VERSION_V2 else "algorithm.v1")
        task = _Task(function(self.context, *args, **kwargs), address, version)
        self.tasks.append(task)
        return task

    def _close_suspended(self) -> None:
        first_error: AuthorError | None = None
        for task in reversed(self.tasks):
            if task.fatal is not None and first_error is None:
                first_error = task.fatal
            if task.done:
                continue
            task.closing = True
            token = _active_task.set(task)
            try:
                task.coroutine.close()
            except AuthorError as exc:
                if first_error is None:
                    first_error = exc
            except BaseException as exc:
                if first_error is None:
                    first_error = AuthorError("AUTHOR_FINALLY", f"{type(exc).__name__} during local cleanup", task.scope)
            finally:
                _active_task.reset(token)
            if task.fatal is not None and first_error is None:
                first_error = task.fatal
        if first_error is not None:
            raise first_error

    def _assert_no_fatal(self) -> None:
        for task in self.tasks:
            if task.fatal is not None:
                raise task.fatal

    def execute(self) -> dict[str, Any]:
        root = self._workflow_task(self.definition, {"args": [], "kwargs": {}}, "r")
        try:
            self._run(root)
            self._assert_no_fatal()
            missing = set(self.history) - self.used_history
            if missing:
                raise AuthorError("AUTHOR_HISTORY_DRIFT", "previously committed address was skipped", sorted(missing)[0])
            if root.done:
                if root.failure is not None:
                    raise root.failure
                result = _plain(root.value)
                validate_json(result)
                if self.request["version"] == WIRE_VERSION_V2 and isinstance(result, dict) and "selected" in result:
                    try:
                        assert_harness_agent_v1(result["selected"])
                    except GearAlgorithmError as exc:
                        raise AuthorError("AUTHOR_RESULT", "selected must be HarnessAgentV1") from exc
                return {"status": "completed", "result": result}
            if not self.frontier:
                raise AuthorError("AUTHOR_DEADLOCK", "workflow paused without an atomic frontier")
            if len({item["address"] for item in self.frontier}) != len(self.frontier):
                raise AuthorError("AUTHOR_ADDRESS", "duplicate frontier address")
            return {"status": "waiting", "frontier": self.frontier}
        finally:
            self._close_suspended()


def replay(definition: WorkflowDefinition, request: Mapping[str, Any]) -> dict[str, Any]:
    """Recompute a complete atomic frontier from a frozen request.

    The host owns journal commits and physical dispatch. This function creates
    no external effects, and no coroutine is reused across invocations.
    """
    if not isinstance(definition, WorkflowDefinition) or not definition.root:
        raise AuthorError("AUTHOR_DEFINITION", "replay requires an @algorithm definition")
    if not isinstance(request, dict) or request.get("version") not in (WIRE_VERSION, WIRE_VERSION_V2):
        raise AuthorError("AUTHOR_PROTOCOL", "unsupported replay wire version")
    if not isinstance(request.get("history"), list) or not isinstance(request.get("input"), dict):
        raise AuthorError("AUTHOR_PROTOCOL", "request requires input and history")
    expected_input = {"initialAgent", "data", "config"}
    if request["version"] == WIRE_VERSION_V2:
        expected_input.add("capabilities")
    if set(request["input"]) != expected_input:
        raise AuthorError("AUTHOR_PROTOCOL", "input fields do not match replay wire version")
    validate_json(request)
    if request["version"] == WIRE_VERSION_V2:
        _check_capabilities(request["input"]["capabilities"])
        try:
            assert_harness_agent_v1(request["input"]["initialAgent"])
        except GearAlgorithmError as exc:
            raise AuthorError("AUTHOR_INPUT", "v2 initialAgent must be HarnessAgentV1") from exc
    if definition.config_schema is not None:
        validate_schema(definition.config_schema, request["input"]["config"], "$.input.config")
    if len(canonical_json(request).encode("utf-8")) > MAX_FRAME_BYTES:
        raise AuthorError("AUTHOR_FRAME_LIMIT", "encoded request exceeds 1 MiB")
    result = _Driver(definition, request).execute()
    if len(canonical_json(result).encode("utf-8")) > MAX_FRAME_BYTES:
        raise AuthorError("AUTHOR_FRAME_LIMIT", "encoded reply exceeds 1 MiB")
    return result


__all__ = ["WIRE_VERSION", "WIRE_VERSION_V2", "CAPABILITIES_VERSION", "ArtifactRef",
           "AuthorCapabilitiesV1", "EvaluationV1", "HarnessAgentV1", "ProposalBatchV1",
           "RoleResultV1", "TaskSelectionV1", "AuthorContext", "AuthorError", "ManagedCall",
           "OperationFailure", "OutcomeView", "WorkflowDefinition", "algorithm", "canonical_json",
           "input_digest", "replay", "workflow"]
