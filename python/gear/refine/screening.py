"""Independent frozen predicate projection over core-bound candidate material."""

from __future__ import annotations

from typing import Any

from gear.canonical import digest
from gear.ops.base import describe_module
from gear.ops.calls import CandidateRef
from gear.ops.candidates import (
    ApplyInput,
    EditCheck,
    EditCheckInput,
    EditPlan,
    FileContent,
    FileEdit,
)
from gear.ops.composition import ScreenCheckInput, ScreenVerdict


def project_screening(algorithm: object, value: dict[str, Any]) -> dict[str, str]:
    components: dict[str, object] = {}

    def capture(component: object) -> None:
        spec = describe_module(component).to_dict()
        components[
            digest({"entrypoint": spec["entrypoint"], "configuration_digest": digest(spec)})
        ] = component

    describe_module(algorithm, on_component=capture)
    policy = value["policy"]
    edit_check = components[digest(policy["edit_check"])]
    predicate = components[digest(policy["predicate"])]
    before = {path: FileContent(**content) for path, content in value["before"].items()}
    after = {path: FileContent(**content) for path, content in value["after"].items()}
    edits = []
    for path in sorted(before.keys() | after.keys()):
        original, result = before.get(path), after.get(path)
        if original == result:
            continue
        edits.append(
            FileEdit(
                "delete" if result is None else "create" if original is None else "replace",
                path,
                original.digest if original is not None else None,
                result,
            )
        )
    checked = edit_check(EditCheckInput(ApplyInput(before, EditPlan(tuple(edits)))))  # type: ignore[operator]
    if not isinstance(checked, EditCheck):
        raise TypeError("frozen edit checker must return EditCheck")
    if checked.status != "allow":
        return {"status": checked.status, "reason": checked.reason}
    verdict = predicate(
        ScreenCheckInput(CandidateRef(**value["candidate"]), checked, value["critic"])
    )  # type: ignore[operator]
    if not isinstance(verdict, ScreenVerdict):
        raise TypeError("frozen screening predicate must return ScreenVerdict")
    return {"status": verdict.status, "reason": verdict.reason}
