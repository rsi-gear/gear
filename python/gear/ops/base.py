"""Configuration trees for callable operators; no execution or implicit run state."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, fields, is_dataclass
from typing import Any, Callable, Protocol, TypeVar

from gear.algorithms.contracts import RandomSource
from gear.canonical import JSON, digest

from ._json import json_object, json_value

InputT = TypeVar("InputT", contravariant=True)
OutputT = TypeVar("OutputT", covariant=True)
_CHILD = "__gear_child__"
_TUPLE = "__gear_tuple__"
_DICT = "__gear_dict__"


def _segment(value: str) -> str:
    """Escape container keys without colliding with the nested-parameter separator."""
    return value.replace("~", "~0").replace("__", "~1") or "~2"


class PureOperator(Protocol[InputT, OutputT]):
    def __call__(self, value: InputT, *, rng: RandomSource | None = None) -> OutputT: ...


def entrypoint(value: object) -> str:
    target = value if inspect.isfunction(value) or inspect.isclass(value) else type(value)
    module = getattr(target, "__module__", "")
    name = getattr(target, "__qualname__", "")
    if (
        not module
        or module == "__main__"
        or not name
        or any(not part.isidentifier() for part in module.split("."))
        or any(not part.isidentifier() or part.startswith("_") for part in name.split("."))
    ):
        raise ValueError("components require public importable functions or classes")
    return module + ":" + name


def _component(value: Any) -> bool:
    return (
        inspect.isfunction(value)
        or isinstance(value, Module)
        or (callable(value) or callable(getattr(value, "step", None)))
        and (
            is_dataclass(value)
            or callable(getattr(value, "get_params", None))
            or isinstance(getattr(value, "configuration", None), dict)
        )
    )


def _parameters(value: object) -> dict[str, Any]:
    result: Any
    if isinstance(value, Module):
        constructor = type(value).__init__
        if constructor is object.__init__:
            return {}
        signature = inspect.signature(constructor)
        names = []
        for name, parameter in signature.parameters.items():
            if name == "self":
                continue
            if parameter.kind in (
                parameter.VAR_POSITIONAL,
                parameter.VAR_KEYWORD,
                parameter.POSITIONAL_ONLY,
            ):
                raise TypeError("Module constructors require named parameters")
            names.append(name)
        result = {name: getattr(value, name) for name in names}
    elif is_dataclass(value) and not isinstance(value, type):
        result = {field.name: getattr(value, field.name) for field in fields(value) if field.init}
    elif callable(getattr(value, "get_params", None)):
        result = value.get_params(deep=False)  # type: ignore[attr-defined]
    else:
        result = getattr(value, "configuration", None)
    if not isinstance(result, dict) or any(
        not isinstance(key, str) or not key.isidentifier() or key.startswith("_") or "__" in key
        for key in result
    ):
        raise TypeError("component configuration requires named constructor parameters")
    return dict(result)


@dataclass(frozen=True)
class FunctionSpec:
    entrypoint: str
    source_dependencies: tuple[tuple[str, str], ...] = ()
    package_dependencies: tuple[str, ...] = ()
    resources: tuple[tuple[str, str], ...] = ()

    def to_dict(self) -> dict[str, JSON]:
        return {
            "kind": "function",
            "entrypoint": self.entrypoint,
            "source_dependencies": json_value(self.source_dependencies),
            "package_dependencies": json_value(self.package_dependencies),
            "resources": json_value(self.resources),
        }


@dataclass(frozen=True)
class ModuleSpec:
    entrypoint: str
    params: dict[str, JSON]
    children: dict[str, ModuleSpec | FunctionSpec]
    source_dependencies: tuple[tuple[str, str], ...] = ()
    package_dependencies: tuple[str, ...] = ()
    resources: tuple[tuple[str, str], ...] = ()
    state_schema_version: int = 1

    def to_dict(self) -> dict[str, JSON]:
        return {
            "kind": "module",
            "entrypoint": self.entrypoint,
            "params": json_object(self.params),
            "children": {name: spec.to_dict() for name, spec in self.children.items()},
            "source_dependencies": json_value(self.source_dependencies),
            "package_dependencies": json_value(self.package_dependencies),
            "resources": json_value(self.resources),
            "state_schema_version": self.state_schema_version,
        }


def _declarations(value: object) -> dict[str, Any]:
    pairs = {}
    for name, attribute in (
        ("source_dependencies", "source_dependencies"),
        ("resources", "source_resources"),
    ):
        supplied = getattr(value, attribute, ())
        if not isinstance(supplied, (tuple, list)) or any(
            not isinstance(pair, (tuple, list))
            or len(pair) != 2
            or any(not isinstance(part, str) or not part for part in pair)
            for pair in supplied
        ):
            raise TypeError(f"{attribute} must contain name/path pairs")
        pairs[name] = tuple(tuple(pair) for pair in supplied)
        if len({pair[0] for pair in supplied}) != len(supplied):
            raise ValueError(f"duplicate {attribute} names")
    packages = getattr(value, "package_dependencies", ())
    if not isinstance(packages, (tuple, list)) or any(
        not isinstance(package, str) or not package for package in packages
    ):
        raise TypeError("package_dependencies must contain distribution names")
    return {**pairs, "package_dependencies": tuple(packages)}


def describe_module(
    value: object, *, on_component: Callable[[object], None] | None = None
) -> ModuleSpec | FunctionSpec:
    """Describe nested components, retaining their types and container structure.

    Children in a parameter container have stable paths, such as ``steps__critic``.
    Tagged containers distinguish user JSON keys from component references.
    The callback belongs to the SDK's admission capture, never to execution.
    """
    active: set[int] = set()
    count = 0

    def describe(item: object, depth: int) -> ModuleSpec | FunctionSpec:
        nonlocal count
        count += 1
        if depth > 32 or count > 1024:
            raise ValueError("component tree exceeds its depth or node limit")
        if id(item) in active:
            raise ValueError("component tree contains a cycle")
        active.add(id(item))
        try:
            name = entrypoint(item)
            if on_component:
                on_component(item)
            declarations = _declarations(item)
            if inspect.isfunction(item):
                return FunctionSpec(name, **declarations)
            children: dict[str, ModuleSpec | FunctionSpec] = {}
            containers: set[int] = set()

            def encode(parameter: Any, path: str, level: int = 0) -> JSON:
                if level > 32:
                    raise ValueError("parameter container exceeds depth limit")
                if _component(parameter):
                    if path in children:
                        raise ValueError("duplicate component path")
                    children[path] = describe(parameter, depth + 1)
                    return {_CHILD: path}
                if isinstance(parameter, (tuple, list, dict)):
                    if id(parameter) in containers:
                        raise ValueError("parameter container contains a cycle")
                    containers.add(id(parameter))
                    try:
                        if isinstance(parameter, dict):
                            if any(not isinstance(key, str) for key in parameter):
                                raise ValueError("parameter dictionary keys must be strings")
                            return {
                                _DICT: {
                                    key: encode(child, path + "__" + _segment(key), level + 1)
                                    for key, child in parameter.items()
                                }
                            }
                        values = [
                            encode(child, path + "__" + str(index), level + 1)
                            for index, child in enumerate(parameter)
                        ]
                        return {_TUPLE: values} if isinstance(parameter, tuple) else values
                    finally:
                        containers.remove(id(parameter))
                return json_value(parameter)

            params = {key: encode(parameter, key) for key, parameter in _parameters(item).items()}
            version = getattr(item, "state_schema_version", 1)
            if type(version) is not int or version < 1:
                raise ValueError("state schema version must be a positive integer")
            return ModuleSpec(name, params, children, **declarations, state_schema_version=version)
        finally:
            active.remove(id(item))

    return describe(value, 0)


def construct_module(
    spec: ModuleSpec | FunctionSpec | dict[str, JSON], resolve: Callable[[str], Any]
) -> Any:
    """Rebuild through a supplied resolver; imports are owned by refine, not operators."""
    count = 0

    def construct(node: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if depth > 32 or count > 1024 or not isinstance(node, dict):
            raise ValueError("invalid component description")
        common = {"kind", "entrypoint", "source_dependencies", "package_dependencies", "resources"}
        expected = (
            common
            if node.get("kind") == "function"
            else common | {"params", "children", "state_schema_version"}
        )
        if set(node) != expected or node.get("kind") not in ("module", "function"):
            raise ValueError("invalid component description fields")
        if not isinstance(node["entrypoint"], str):
            raise ValueError("invalid component entrypoint")
        target = resolve(node["entrypoint"])
        if entrypoint(target) != node["entrypoint"]:
            raise ValueError("component entrypoint identity changed")
        if node["kind"] == "function":
            if not inspect.isfunction(target):
                raise TypeError("function component does not resolve to a function")
            if describe_module(target).to_dict() != node:
                raise ValueError("function declarations changed during reconstruction")
            return target
        if (
            not inspect.isclass(target)
            or not isinstance(node["params"], dict)
            or not isinstance(node["children"], dict)
        ):
            raise TypeError("module component requires a class, parameters and children")
        if type(node["state_schema_version"]) is not int or node["state_schema_version"] < 1:
            raise ValueError("invalid state schema version")
        used: set[str] = set()

        def decode(parameter: Any, level: int = 0) -> Any:
            if level > 32:
                raise ValueError("parameter container exceeds depth limit")
            if isinstance(parameter, dict):
                if _CHILD in parameter:
                    path = parameter[_CHILD]
                    if (
                        set(parameter) != {_CHILD}
                        or not isinstance(path, str)
                        or path in used
                        or path not in node["children"]
                    ):
                        raise ValueError("invalid component parameter reference")
                    used.add(path)
                    return construct(node["children"][path], depth + 1)
                if _TUPLE in parameter:
                    if set(parameter) != {_TUPLE} or not isinstance(parameter[_TUPLE], list):
                        raise ValueError("invalid tuple parameter")
                    return tuple(decode(child, level + 1) for child in parameter[_TUPLE])
                if set(parameter) != {_DICT} or not isinstance(parameter[_DICT], dict):
                    raise ValueError("invalid dictionary parameter")
                return {key: decode(child, level + 1) for key, child in parameter[_DICT].items()}
            if isinstance(parameter, list):
                return [decode(child, level + 1) for child in parameter]
            return json_value(parameter)

        parameters = {key: decode(parameter) for key, parameter in node["params"].items()}
        if used != set(node["children"]):
            raise ValueError("unreferenced child component")
        result = target(**parameters)
        if getattr(result, "state_schema_version", 1) != node["state_schema_version"]:
            raise ValueError("component state schema version changed")
        if describe_module(result).to_dict() != node:
            raise ValueError(
                "component configuration or declarations changed during reconstruction"
            )
        return result

    wire = spec.to_dict() if isinstance(spec, (ModuleSpec, FunctionSpec)) else json_object(spec)
    from .wire import validate_v2

    validate_v2("ComponentSpec", wire)
    return construct(wire, 0)


class Module:
    """Optional configuration conveniences; persistence belongs to AlgorithmState."""

    state_schema_version = 1

    def resource(self, name: str) -> str:
        """Read a declared UTF-8 resource already loaded from the frozen admission package."""
        return resource_bytes(self, name).decode("utf-8", errors="strict")

    def get_params(self, deep: bool = True) -> dict[str, Any]:
        result = _parameters(self)
        if deep:
            # Description detects cycles before walking the original parameter objects.
            self.describe()

            def add(value: Any, prefix: str) -> None:
                if _component(value) and not inspect.isfunction(value):
                    for name, parameter in _parameters(value).items():
                        path = prefix + "__" + name
                        result[path] = parameter
                        add(parameter, path)
                elif isinstance(value, dict):
                    for key, child in value.items():
                        path = prefix + "__" + _segment(key)
                        result[path] = child
                        add(child, path)
                elif isinstance(value, (tuple, list)):
                    for index, child in enumerate(value):
                        result[prefix + "__" + str(index)] = child
                        add(child, prefix + "__" + str(index))

            for name, value in list(result.items()):
                add(value, name)
        return result

    def set_params(self, **params: Any) -> Module:
        if getattr(self, "_configuration_frozen", False):
            raise ValueError("admitted component configuration is frozen")
        # Stage on a clone so an invalid nested replacement cannot partly mutate self.
        staged = clone(self)

        def replace(value: Any, parts: list[str], replacement: Any) -> Any:
            if not parts:
                return replacement
            key, *rest = parts
            if isinstance(value, dict):
                return {
                    name: replace(child, rest, replacement) if _segment(name) == key else child
                    for name, child in value.items()
                }
            if isinstance(value, (tuple, list)):
                values = [
                    replace(child, rest, replacement) if index == int(key) else child
                    for index, child in enumerate(value)
                ]
                return tuple(values) if isinstance(value, tuple) else values
            current = _parameters(value)
            current[key] = replace(current[key], rest, replacement)
            return type(value)(**current)

        for path, value in sorted(params.items(), key=lambda item: item[0].count("__")):
            if path not in staged.get_params(deep=True):
                raise ValueError("unknown component parameter")
            staged = replace(staged, path.split("__"), value)
        staged.describe()
        for name, value in _parameters(staged).items():
            setattr(self, name, value)
        return self

    def named_children(self) -> tuple[tuple[str, Any], ...]:
        return tuple(
            (key, value) for key, value in self.get_params(deep=True).items() if _component(value)
        )

    def describe(self) -> ModuleSpec:
        spec = describe_module(self)
        assert isinstance(spec, ModuleSpec)
        return spec

    @property
    def operator_ref(self) -> dict[str, JSON]:
        spec = self.describe().to_dict()
        return {"entrypoint": spec["entrypoint"], "configuration_digest": digest(spec)}


def clone(value: Any) -> Any:
    targets: dict[str, Any] = {}

    def capture(component: object) -> None:
        targets[entrypoint(component)] = (
            component if inspect.isfunction(component) else type(component)
        )

    spec = describe_module(value, on_component=capture)
    return construct_module(spec, targets.__getitem__)


def freeze_module(value: Any) -> Any:
    """Freeze a detached configuration tree. The caller's original remains editable."""
    result = clone(value)

    def freeze(component: object) -> None:
        if isinstance(component, Module):
            object.__setattr__(component, "_configuration_frozen", True)

    describe_module(result, on_component=freeze)
    return result


def resource_bytes(component: object, name: str) -> bytes:
    values = getattr(component, "_resource_values", {})
    if not isinstance(values, dict) or name not in values or not isinstance(values[name], bytes):
        raise ValueError(
            "resource is unavailable; declare it and load the frozen component package"
        )
    return bytes(values[name])


def required_capabilities(value: object) -> tuple[str, ...]:
    result: set[str] = set()

    def collect(component: object) -> None:
        method = getattr(component, "requirements", None)
        names = method() if callable(method) else ()
        if not isinstance(names, (tuple, list)) or any(
            not isinstance(name, str) or not name.isidentifier() for name in names
        ):
            raise ValueError("requirements must contain capability names")
        result.update(names)

    describe_module(value, on_component=collect)
    return tuple(sorted(result))
