"""Sync/async project API; TypeScript owns all durable experiment state."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import json
import os
import shutil
import tempfile
from collections.abc import Coroutine
from dataclasses import dataclass, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, TypeVar, cast

from .canonical import JSON

T = TypeVar("T")

if TYPE_CHECKING:
    from gear.core.policy import AccessPolicy, ImportSource, ScreeningPolicy
    from gear.search.api import SearchAlgorithm as OperatorSearchAlgorithm
    from gear.search.contracts_v1 import SearchAlgorithm as LegacySearchAlgorithm

    SearchAlgorithm = LegacySearchAlgorithm | OperatorSearchAlgorithm


class ProjectError(RuntimeError):
    def __init__(self, code: str, message: str, *, stderr: bytes | None = None):
        super().__init__(message)
        self.code = code
        # Private process diagnostics may contain credentials; never add them to str(error).
        self.stderr = stderr

    @classmethod
    def from_stderr(cls, stderr: bytes) -> ProjectError:
        """Read the CLI's terminal error line, preserving preceding warnings as diagnostics."""
        lines = stderr.splitlines()
        terminal = next((line.strip() for line in reversed(lines) if line.strip()), b"")

        def unique_object(pairs: list[tuple[str, JSON]]) -> dict[str, JSON]:
            result: dict[str, JSON] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate error field")
                result[key] = value
            return result

        try:
            detail = json.loads(terminal, object_pairs_hook=unique_object)
            fields = {
                "code",
                "message",
                "retryable",
                "location",
                "next_action",
                "run_id",
                "operation_id",
            }
            if (
                not isinstance(detail, dict)
                or not {"code", "message"}.issubset(detail)
                or not set(detail).issubset(fields)
                or not isinstance(detail["code"], str)
                or not detail["code"]
                or not isinstance(detail["message"], str)
                or not detail["message"]
                or any(
                    not isinstance(value, str)
                    for key, value in detail.items()
                    if key != "retryable"
                )
                or ("retryable" in detail and not isinstance(detail["retryable"], bool))
            ):
                raise ValueError("invalid terminal error envelope")
            return cls(detail["code"], detail["message"], stderr=stderr)
        except (ValueError, RecursionError):
            return cls(
                "runtime-failed",
                "Gear runtime exited without a structured terminal error; inspect the saved stderr",
                stderr=stderr,
            )


@dataclass(frozen=True)
class Report:
    summary: dict[str, JSON]


@dataclass(frozen=True)
class Run:
    id: str
    report: Report


class Project:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        if not (self.root / "gear.yaml").is_file():
            raise ProjectError(
                "project-not-found", "gear.yaml was not found in the project directory"
            )

    @classmethod
    def open(cls, root: str | Path = ".") -> Project:
        return cls(root)

    def check(self) -> dict[str, JSON]:
        return self._sync(self.acheck())

    async def acheck(self) -> dict[str, JSON]:
        return await self._call(["benchmark", "check"])

    def probe_benchmark(
        self, *, task_id: str | None = None, scorer: bool = False, image: str | None = None
    ) -> dict[str, JSON]:
        """Build a seed task environment and optionally run its verifier fixtures, without a model."""
        return self._sync(self.aprobe_benchmark(task_id=task_id, scorer=scorer, image=image))

    async def aprobe_benchmark(
        self, *, task_id: str | None = None, scorer: bool = False, image: str | None = None
    ) -> dict[str, JSON]:
        args = ["benchmark", "probe"]
        if task_id is not None:
            args += ["--task", task_id]
        if scorer:
            args.append("--scorer")
        if image is not None:
            args += ["--image", image]
        return await self._call(args)

    def doctor(self) -> dict[str, JSON]:
        """Inspect local prerequisites without making model calls."""
        return self._sync(self.adoctor())

    async def adoctor(self) -> dict[str, JSON]:
        return await self._call(["doctor"])

    def profiles(self) -> dict[str, JSON]:
        return self._sync(self.aprofiles())

    async def aprofiles(self) -> dict[str, JSON]:
        return await self._call(["profile", "list"])

    def use_profile(self, name: str, *, role: str) -> dict[str, JSON]:
        return self._sync(self.ause_profile(name, role=role))

    async def ause_profile(self, name: str, *, role: str) -> dict[str, JSON]:
        return await self._call(["profile", "use", name, "--role", role])

    def create_profile(self, name: str, configuration: dict[str, JSON]) -> dict[str, JSON]:
        return self._sync(self.acreate_profile(name, configuration))

    async def acreate_profile(self, name: str, configuration: dict[str, JSON]) -> dict[str, JSON]:
        """Import provider settings; store credential references, never secret values."""
        with tempfile.TemporaryDirectory(prefix="gear-profile-") as directory:
            path = Path(directory) / "profile.json"
            path.write_text(json.dumps(configuration))
            return await self._call(["profile", "create", name, "--from", str(path)])

    def import_benchmark(
        self,
        source: str | Path,
        *,
        template: str = "text",
        research: bool = False,
        resource_root: str | Path | None = None,
    ) -> dict[str, JSON]:
        """Preview a frozen import and its explicit split manifest; does not replace project data."""
        return self._sync(
            self.aimport_benchmark(
                source, template=template, research=research, resource_root=resource_root
            )
        )

    async def aimport_benchmark(
        self,
        source: str | Path,
        *,
        template: str = "text",
        research: bool = False,
        resource_root: str | Path | None = None,
    ) -> dict[str, JSON]:
        args = ["benchmark", "import", str(source), "--template", template]
        if research:
            args.append("--research")
        if resource_root is not None:
            args += ["--resource-root", str(resource_root)]
        return await self._call(args)

    def apply_benchmark_import(self, plan_id: str) -> dict[str, JSON]:
        return self._sync(self.aapply_benchmark_import(plan_id))

    async def aapply_benchmark_import(self, plan_id: str) -> dict[str, JSON]:
        return await self._call(["benchmark", "import", "--apply", plan_id])

    def evaluate(self, *, split: str = "seed", limit: int | None = None) -> Run:
        return self._sync(self.aevaluate(split=split, limit=limit))

    async def aevaluate(self, *, split: str = "seed", limit: int | None = None) -> Run:
        args = ["evaluate", "--split", split]
        if limit is not None:
            args += ["--limit", str(limit)]
        result = await self._call(args)
        return Run(str(result["run_id"]), Report(result))

    def refine(
        self,
        *,
        algorithm: SearchAlgorithm | None = None,
        rounds: int = 1,
        screening: ScreeningPolicy | None = None,
        access: AccessPolicy | None = None,
        imports: tuple[ImportSource, ...] = (),
    ) -> Run:
        return self._sync(
            self.arefine(
                algorithm=algorithm,
                rounds=rounds,
                screening=screening,
                access=access,
                imports=imports,
            )
        )

    def plan_refine(
        self,
        *,
        algorithm: SearchAlgorithm | None = None,
        rounds: int = 1,
        screening: ScreeningPolicy | None = None,
        access: AccessPolicy | None = None,
        imports: tuple[ImportSource, ...] = (),
    ) -> dict[str, JSON]:
        """Inspect scope, verified baseline reuse and limits without creating or executing a run."""
        return self._sync(
            self.aplan_refine(
                algorithm=algorithm,
                rounds=rounds,
                screening=screening,
                access=access,
                imports=imports,
            )
        )

    async def aplan_refine(
        self,
        *,
        algorithm: SearchAlgorithm | None = None,
        rounds: int = 1,
        screening: ScreeningPolicy | None = None,
        access: AccessPolicy | None = None,
        imports: tuple[ImportSource, ...] = (),
    ) -> dict[str, JSON]:
        return await self._refine(
            algorithm=algorithm,
            rounds=rounds,
            preview=True,
            screening=screening,
            access=access,
            imports=imports,
        )

    async def arefine(
        self,
        *,
        algorithm: SearchAlgorithm | None = None,
        rounds: int = 1,
        screening: ScreeningPolicy | None = None,
        access: AccessPolicy | None = None,
        imports: tuple[ImportSource, ...] = (),
    ) -> Run:
        result = await self._refine(
            algorithm=algorithm,
            rounds=rounds,
            preview=False,
            screening=screening,
            access=access,
            imports=imports,
        )
        return Run(str(result["run_id"]), Report(result))

    async def _refine(
        self,
        *,
        algorithm: SearchAlgorithm | None,
        rounds: int,
        preview: bool,
        screening: ScreeningPolicy | None = None,
        access: AccessPolicy | None = None,
        imports: tuple[ImportSource, ...] = (),
    ) -> dict[str, JSON]:
        args = ["refine", "--rounds", str(rounds)]
        if preview:
            args.append("--dry-run")
        if algorithm is None:
            if screening is not None or access is not None or imports:
                raise ValueError("admission policies require an explicit v2 algorithm")
            result = await self._call(args)
        else:
            with tempfile.TemporaryDirectory(prefix="gear-algorithm-") as directory:
                path = Path(directory) / "algorithm.json"
                description = self._describe_algorithm(algorithm)
                if screening is not None:
                    if getattr(algorithm, "protocol_version", 1) != 2:
                        raise ValueError("screening requires an explicit v2 algorithm")
                    description["screening"] = screening.to_dict()
                if access is not None:
                    if getattr(algorithm, "protocol_version", 1) != 2:
                        raise ValueError("access requires an explicit v2 algorithm")
                    description["access"] = access.to_dict()
                if imports:
                    if getattr(algorithm, "protocol_version", 1) != 2:
                        raise ValueError("imports require an explicit v2 algorithm")
                    description["imports"] = [item.to_dict() for item in imports]
                path.write_text(json.dumps(description))
                result = await self._call(args + ["--algorithm-config", str(path)])
        return result

    def resume(self, run_id: str) -> Run:
        return self._sync(self.aresume(run_id))

    async def aresume(self, run_id: str) -> Run:
        result = await self._call(["resume", run_id])
        return Run(str(result["run_id"]), Report(result))

    def cancel(self, run_id: str) -> dict[str, JSON]:
        return self._sync(self.acancel(run_id))

    async def acancel(self, run_id: str) -> dict[str, JSON]:
        return await self._call(["cancel", run_id])

    def report(self, run_id: str) -> Report:
        return self._sync(self.areport(run_id))

    async def areport(self, run_id: str) -> Report:
        return Report(await self._call(["report", run_id]))

    def archive(self, run_id: str) -> dict[str, JSON]:
        """Read the immutable seed research archive; contains no held-out observations."""
        return self._sync(self.aarchive(run_id))

    async def aarchive(self, run_id: str) -> dict[str, JSON]:
        return await self._call(["archive", run_id])

    def experience_query(
        self,
        run_id: str,
        query: dict[str, JSON] | None = None,
        *,
        snapshot: str | None = None,
        cursor: str | None = None,
        limit: int = 10,
    ) -> dict[str, JSON]:
        """Query seed edit outcomes. Keep snapshot_digest when requesting further pages."""
        return self._sync(
            self.aexperience_query(run_id, query, snapshot=snapshot, cursor=cursor, limit=limit)
        )

    async def aexperience_query(
        self,
        run_id: str,
        query: dict[str, JSON] | None = None,
        *,
        snapshot: str | None = None,
        cursor: str | None = None,
        limit: int = 10,
    ) -> dict[str, JSON]:
        args = [
            "experience",
            "query",
            run_id,
            "--query-json",
            json.dumps(query or {}),
            "--limit",
            str(limit),
        ]
        if snapshot is not None:
            args += ["--snapshot", snapshot]
        if cursor is not None:
            args += ["--cursor", cursor]
        return await self._call(args)

    def experience_read(
        self,
        run_id: str,
        ref: str,
        *,
        view: str = "card",
        snapshot: str | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, JSON]:
        return self._sync(
            self.aexperience_read(
                run_id, ref, view=view, snapshot=snapshot, cursor=cursor, limit=limit
            )
        )

    async def aexperience_read(
        self,
        run_id: str,
        ref: str,
        *,
        view: str = "card",
        snapshot: str | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, JSON]:
        args = ["experience", "read", run_id, ref, "--view", view, "--limit", str(limit)]
        if snapshot is not None:
            args += ["--snapshot", snapshot]
        if cursor is not None:
            args += ["--cursor", cursor]
        return await self._call(args)

    def experience_trajectory(
        self,
        run_id: str,
        ref: str,
        source_ref: str,
        *,
        snapshot: str,
        query: dict[str, JSON] | None = None,
    ) -> dict[str, JSON]:
        """Read an authorized historical seed trajectory; pages stay bound to the snapshot."""
        return self._sync(
            self.aexperience_trajectory(run_id, ref, source_ref, snapshot=snapshot, query=query)
        )

    async def aexperience_trajectory(
        self,
        run_id: str,
        ref: str,
        source_ref: str,
        *,
        snapshot: str,
        query: dict[str, JSON] | None = None,
    ) -> dict[str, JSON]:
        return await self._call(
            [
                "experience",
                "trajectory",
                run_id,
                ref,
                source_ref,
                "--snapshot",
                snapshot,
                "--query-json",
                json.dumps(query or {}),
            ]
        )

    def export(self, run_id: str) -> dict[str, JSON]:
        return self._sync(self.aexport(run_id))

    async def aexport(self, run_id: str) -> dict[str, JSON]:
        return await self._call(["export", run_id])

    async def _call(self, args: list[str]) -> dict[str, JSON]:
        if "GEAR_COMMAND" in os.environ:
            command = json.loads(os.environ["GEAR_COMMAND"])
            if (
                not isinstance(command, list)
                or not command
                or not all(isinstance(item, str) for item in command)
            ):
                raise ProjectError(
                    "invalid-runtime-command", "GEAR_COMMAND must be a JSON argv array"
                )
        else:
            executable = shutil.which("gear")
            if executable is None:
                raise ProjectError(
                    "runtime-not-installed",
                    "Install the runtime with npm install --global rsi-gear, then run gear setup",
                )
            command = [executable]
        process = await asyncio.create_subprocess_exec(
            *command,
            "--project",
            str(self.root),
            "--json",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            process.terminate()
            await process.wait()
            raise
        if process.returncode:
            raise ProjectError.from_stderr(stderr)
        result = json.loads(stdout)
        if not isinstance(result, dict):
            raise ProjectError(
                "invalid-runtime-response",
                "Runtime returned an invalid project response",
            )
        from .refine.protocol import validate

        validate("Json", result)
        return cast(dict[str, JSON], result)

    @staticmethod
    def _sync(awaitable: Coroutine[object, object, T]) -> T:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(awaitable)
        awaitable.close()
        raise ProjectError(
            "event-loop-active",
            "Use the asynchronous Project API inside an active event loop",
        )

    @staticmethod
    def _describe_algorithm(algorithm: SearchAlgorithm) -> dict[str, JSON]:
        from gear.core.base import (
            Module,
            describe_module,
            entrypoint,
            required_capabilities,
        )

        from .algorithms import GEPA, RandomSearch
        from .refine.protocol import validate

        name = (
            "gepa"
            if type(algorithm) is GEPA
            else "random-search"
            if type(algorithm) is RandomSearch
            else type(algorithm).__module__ + ":" + type(algorithm).__qualname__
        )
        options: dict[str, JSON] = {}
        sources: dict[str, JSON] = {}
        dependencies: set[str] = set()
        resources: dict[tuple[str, str, str], dict[str, JSON]] = {}
        resource_bytes = 0

        def add_source(relative: str, path: Path) -> None:
            description: dict[str, JSON] = {"path": relative, "source": str(path.resolve())}
            if relative in sources and sources[relative] != description:
                raise ProjectError(
                    "algorithm-source-conflict", "Conflicting sources for " + relative
                )
            sources[relative] = description

        def declared_dependencies(value: object) -> None:
            nonlocal resource_bytes
            for dependency in getattr(value, "package_dependencies", ()):
                if not isinstance(dependency, str) or not dependency:
                    raise ProjectError(
                        "invalid-package-dependency",
                        "Package dependencies must name installed distributions",
                    )
                dependencies.add(dependency)
            for module, path in getattr(value, "source_dependencies", ()):
                relative = module.replace(".", "/") + (
                    "/__init__.py" if Path(path).name == "__init__.py" else ".py"
                )
                add_source(relative, Path(path))
            for resource_name, resource_path in getattr(value, "source_resources", ()):
                key = (entrypoint(value), resource_name, resource_path)
                if key in resources:
                    continue
                path = Path(resource_path)
                if not path.is_absolute():
                    owner = (
                        value
                        if inspect.isfunction(value) or inspect.isclass(value)
                        else type(value)
                    )
                    source_file = inspect.getsourcefile(owner)
                    if source_file is None:
                        raise ProjectError(
                            "algorithm-resource-invalid", "Resource owner has no source file"
                        )
                    path = Path(source_file).parent / path
                if not path.is_file() or path.is_symlink() or path.stat().st_size > 1024 * 1024:
                    raise ProjectError(
                        "algorithm-resource-invalid",
                        "Resources must be regular files of at most 1 MiB",
                    )
                with path.open("rb") as stream:
                    content = stream.read(1024 * 1024 + 1)
                resource_bytes += len(content)
                if (
                    len(content) > 1024 * 1024
                    or resource_bytes > 8 * 1024 * 1024
                    or len(resources) >= 1024
                ):
                    raise ProjectError(
                        "algorithm-resource-limit",
                        "Declared resources exceed frozen package bounds",
                    )
                resources[key] = {
                    "entrypoint": key[0],
                    "name": resource_name,
                    "path": resource_path,
                    "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
                    "content_base64": base64.b64encode(content).decode("ascii"),
                }

        def capture(value: object) -> str:
            if inspect.isfunction(value):
                declared_dependencies(value)
            if not inspect.isfunction(value) and not inspect.isclass(value):
                raise ProjectError(
                    "algorithm-source-unavailable",
                    "Entrypoint must be a named function or class",
                )
            module = getattr(value, "__module__", "")
            qualname = getattr(value, "__qualname__", "")
            if (
                not module
                or not qualname
                or "<locals>" in qualname
                or "<lambda>" in qualname
                or module == "__main__"
            ):
                raise ProjectError(
                    "algorithm-source-unavailable",
                    "Algorithms must use importable functions/classes in Python files",
                )
            if module.startswith("gear."):
                return module + ":" + qualname
            source = inspect.getsourcefile(value)
            if source is None:
                raise ProjectError(
                    "algorithm-source-unavailable",
                    "Algorithm source file was not found",
                )
            path = Path(source).resolve()
            parts = module.split(".")
            relative = "/".join(parts) + ("/__init__.py" if path.name == "__init__.py" else ".py")
            add_source(relative, path)
            parent = path.parent if path.name != "__init__.py" else path.parent.parent
            for count in range(len(parts) - 1, 0, -1):
                initializer = parent / "__init__.py"
                if initializer.is_file():
                    package_path = "/".join(parts[:count]) + "/__init__.py"
                    add_source(package_path, initializer)
                parent = parent.parent
            return module + ":" + qualname

        capture(type(algorithm))
        if getattr(algorithm, "protocol_version", 1) not in (1, 2):
            raise ProjectError(
                "algorithm-protocol-unsupported", "Only algorithm protocols v1 and v2 are supported"
            )

        def capture_component(value: object) -> None:
            declared_dependencies(value)
            capture(value if inspect.isfunction(value) else type(value))

        # New author modules retain every constructor parameter and every child type.
        # The legacy built-ins keep their established five-policy description below.
        if type(algorithm) not in (GEPA, RandomSearch) and (
            isinstance(algorithm, Module)
            or is_dataclass(algorithm)
            or callable(getattr(algorithm, "get_params", None))
        ):
            component = describe_module(algorithm, on_component=capture_component).to_dict()
            from .refine.dependencies import dependency_identity

            return {
                "algorithm": {
                    "name": name,
                    "options": {},
                    "component": component,
                    **(
                        {
                            "protocol_version": 2,
                            "requirements": list(required_capabilities(algorithm)),
                        }
                        if getattr(algorithm, "protocol_version", 1) == 2
                        else {}
                    ),
                },
                "sources": list(sources.values()),
                "dependencies": [dependency_identity(item) for item in sorted(dependencies)],
                **({"resources": list(resources.values())} if resources else {}),
            }
        for field in (
            "parent_policy",
            "sampler",
            "proposal_planner",
            "ranker",
            "stop_rule",
        ):
            value = getattr(algorithm, field, None)
            if value is None:
                continue
            declared_dependencies(value)
            if inspect.isfunction(value):
                options[field] = capture(value)
            elif (
                is_dataclass(value)
                and not isinstance(value, type)
                or isinstance(value, Module)
                or callable(getattr(value, "get_params", None))
            ):
                options[field] = {
                    "component": describe_module(value, on_component=capture_component).to_dict()
                }
            else:
                raise ProjectError(
                    "algorithm-policy-not-serializable",
                    "Use a named function or a dataclass policy with JSON configuration",
                )
        if type(algorithm) is GEPA:
            options["promotion_widths"] = list(algorithm.promotion_widths)
            # Omitted at its default so existing run specifications keep their identity.
            if algorithm.global_gate != "any":
                options["global_gate"] = algorithm.global_gate
        if type(algorithm) is RandomSearch:
            options["diagnose"] = algorithm.diagnose
        if type(algorithm) not in (GEPA, RandomSearch):
            configuration = getattr(algorithm, "configuration", {})
            validate("Json", configuration)
            if not isinstance(configuration, dict):
                raise ProjectError(
                    "algorithm-configuration-invalid",
                    "Custom algorithm configuration must be a JSON object",
                )
            options.update(configuration)
        declared_dependencies(algorithm)
        from .refine.dependencies import dependency_identity

        return {
            "algorithm": {"name": name, "options": options},
            "sources": list(sources.values()),
            "dependencies": [dependency_identity(name) for name in sorted(dependencies)],
            **({"resources": list(resources.values())} if resources else {}),
        }
