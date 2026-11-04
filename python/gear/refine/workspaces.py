"""Persistent draft revisions, edited through the configured Meta executor."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any, cast

from gear.canonical import JSON, digest

from .contracts import Candidate, Operation, OperationResult, Task

if TYPE_CHECKING:
    from .run_context import RoleResult, RunContext


@dataclass(frozen=True)
class WorkspaceRef:
    id: str
    digest: str
    root_id: str
    parent_id: str | None
    base_candidate_id: str
    base_digest: str


class WorkspaceAccess:
    def __init__(self, context: RunContext) -> None:
        self._context = context

    def _id(self, key: str) -> str:
        return "draft-" + digest([self._context.run_id, key])[7:31]

    @staticmethod
    def _revision(result: OperationResult) -> WorkspaceRef:
        if result.status != "complete" or not isinstance(result.data, dict):
            raise ValueError("workspace operation failed: " + str(result.data))
        return WorkspaceRef(**cast(dict[str, Any], result.data["workspace"]))

    async def open(self, *, base: Candidate | str, key: str) -> WorkspaceRef:
        parent = self._context._candidate(base)
        operation = Operation(
            "workspace_open",
            parent_id=parent.id,
            rationale="open draft",
            payload={
                "gear_workspace_v1": {"output_id": self._id(key), "base_digest": parent.digest},
            },
        )
        return self._revision((await self._context.perform((operation,), key=key))[0])

    async def edit(
        self,
        name: str,
        *,
        workspace: WorkspaceRef,
        key: str,
        inputs: JSON = None,
        tasks: Sequence[Task | str] | None = None,
        references: Mapping[str, Candidate] | None = None,
        materials: Mapping[str, Any] | None = None,
        write_paths: Sequence[str] | None = None,
    ) -> RoleResult:
        from .run_context import RoleResult

        role = self._context.roles._roles[name]
        if not role.edits:
            raise ValueError("workspace editor role must declare edits=True")
        payload: dict[str, JSON] = {
            "meta": {"prompt": role.prompt, "schema": role.schema},
            "inputs": inputs,
            "gear_role_v1": name,
            "gear_workspace_v1": {
                "source": cast(JSON, asdict(workspace)),
                "output_id": self._id(key),
            },
        }
        if write_paths is not None:
            payload["gear_write_paths_v1"] = list(write_paths)
        if materials:
            payload["gear_materials_v1"] = {
                label: {
                    "operation_id": (
                        value if isinstance(value, OperationResult) else value.operation
                    ).operation_id
                }
                for label, value in materials.items()
            }
        if references:
            payload["gear_candidate_references_v1"] = {
                label: {"candidate_id": value.id, "digest": value.digest}
                for label, value in references.items()
            }
        operation = Operation(
            "workspace_edit",
            parent_id=workspace.base_candidate_id,
            task_ids=self._context._tasks(tasks),
            rationale=name,
            payload=payload,
        )
        result = (await self._context.perform((operation,), key=key))[0]
        data = result.data
        value = data.get("data") if isinstance(data, dict) and "declined" in data else data
        revision = self._revision(result) if result.status == "complete" else None
        return RoleResult(result, value, revision=revision)

    async def apply(
        self, workspace: WorkspaceRef, *, edits: Mapping[str, str | None], key: str
    ) -> WorkspaceRef:
        operation = Operation(
            "workspace_apply",
            parent_id=workspace.base_candidate_id,
            rationale="apply draft changes",
            payload={
                "gear_workspace_v1": {
                    "source": cast(JSON, asdict(workspace)),
                    "output_id": self._id(key),
                },
                "edits": cast(JSON, dict(edits)),
            },
        )
        return self._revision((await self._context.perform((operation,), key=key))[0])

    async def seal(self, workspace: WorkspaceRef, *, key: str) -> Candidate:
        candidate_id = "workflow-" + digest([self._context.run_id, key])[7:31]
        operation = Operation(
            "workspace_seal",
            candidate_id=candidate_id,
            parent_id=workspace.base_candidate_id,
            rationale="seal draft",
            payload={
                "gear_workspace_v1": {"source": cast(JSON, asdict(workspace))},
            },
        )
        result = (await self._context.perform((operation,), key=key))[0]
        if result.status != "complete":
            raise ValueError("workspace seal failed: " + str(result.data))
        return self._context._candidate(candidate_id)

    async def discard(self, workspace: WorkspaceRef, *, key: str) -> None:
        operation = Operation(
            "workspace_discard",
            parent_id=workspace.base_candidate_id,
            rationale="discard draft",
            payload={"gear_workspace_v1": {"source": cast(JSON, asdict(workspace))}},
        )
        result = (await self._context.perform((operation,), key=key))[0]
        if result.status != "complete":
            raise ValueError("workspace discard failed: " + str(result.data))
