"""Author reads and edits of immutable candidate and draft resources."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any, cast

from gear.canonical import JSON

from .contracts import Candidate, Operation, OperationKind, OperationResult
from .workspaces import WorkspaceRef

if TYPE_CHECKING:
    from .run_context import RunContext


@dataclass(frozen=True)
class Material:
    operation: OperationResult
    data: JSON


class ArtifactAccess:
    def __init__(self, context: RunContext) -> None:
        self._context = context

    def _ref(self, value: Candidate | WorkspaceRef | str) -> dict[str, JSON]:
        if isinstance(value, WorkspaceRef):
            return cast(dict[str, JSON], asdict(value))
        candidate = self._context._candidate(value)
        return {"candidate_id": candidate.id, "digest": candidate.digest}

    async def _read(
        self,
        kind: OperationKind,
        source: Candidate | WorkspaceRef | str,
        *,
        key: str,
        **query: JSON,
    ) -> dict[str, Any]:
        ref = self._ref(source)
        operation = Operation(
            kind,
            parent_id=cast(str, ref.get("candidate_id", ref.get("base_candidate_id"))),
            rationale=kind,
            payload={"gear_artifact_v1": cast(JSON, {"source": ref, **query})},
        )
        result = (await self._context.perform((operation,), key=key))[0]
        if result.status != "complete":
            raise ValueError("artifact read failed")
        return cast(dict[str, Any], result.data)

    async def list(self, source: Candidate | WorkspaceRef | str, *, key: str) -> dict[str, Any]:
        return await self._read("artifact_list", source, key=key)

    async def read(
        self, source: Candidate | WorkspaceRef | str, *, paths: Sequence[str], key: str
    ) -> dict[str, str]:
        return cast(
            dict[str, str],
            (await self._read("artifact_read", source, paths=list(paths), key=key))["files"],
        )

    async def diff(
        self,
        source: Candidate | WorkspaceRef | str,
        other: Candidate | WorkspaceRef | str,
        *,
        key: str,
    ) -> dict[str, Any]:
        return await self._read("artifact_diff", source, other=self._ref(other), key=key)

    async def material(self, value: JSON, *, key: str) -> Material:
        operation = Operation(
            "artifact_material",
            parent_id=self._context.inputs.anchor.id,
            rationale="pin author material",
            payload={"gear_material_v1": value},
        )
        result = (await self._context.perform((operation,), key=key))[0]
        return Material(result, result.data)

    async def apply(
        self, *, base: Candidate | str, edits: Mapping[str, str | None], key: str
    ) -> Candidate:
        draft = await self._context.workspaces.open(base=base, key=key + "/open")
        draft = await self._context.workspaces.apply(draft, edits=edits, key=key + "/apply")
        return await self._context.workspaces.seal(draft, key=key + "/seal")
