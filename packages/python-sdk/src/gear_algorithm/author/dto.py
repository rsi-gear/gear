"""A1 author JSON DTO declarations and pure structural validation.

These checks do not grant artifact or binding authority. The trusted host
verifies referenced CAS bytes, Git state, profile lock and physical receipts.
"""
from __future__ import annotations

import math
import re
from typing import Any, NotRequired, TypedDict

from gear_algorithm.errors import ValidationError
from gear_algorithm.protocol import json_safe_integer, validate_json


AUTHOR_CAPABILITIES_VERSION = "gear.author.capabilities.v1"
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,127}\Z")


class ArtifactRef(TypedDict):
    kind: str
    digest: str
    size: int
    mediaType: str
    schemaId: NotRequired[str]


class BindingSetRef(TypedDict):
    kind: str
    digest: str
    schemaId: str


class HarnessAgentV1(TypedDict):
    schemaVersion: int
    kind: str
    bindingSetRef: BindingSetRef
    executionProfileDigest: str
    proposalIndex: NotRequired[int]


class TaskSelectionV1(TypedDict):
    schemaVersion: int
    taskViewRef: ArtifactRef
    selectedTaskIds: list[str]
    cursor: dict[str, Any]


class RoleResultV1(TypedDict):
    schemaVersion: int
    output: Any
    evidenceRef: ArtifactRef
    receiptRef: ArtifactRef


class ProposalFailureV1(TypedDict):
    index: int
    stage: str
    code: str
    message: str
    evidenceRefs: list[ArtifactRef]
    checkReportRef: NotRequired[ArtifactRef]


class ProposalBatchV1(TypedDict):
    schemaVersion: int
    requestedCount: int
    candidates: list[HarnessAgentV1]
    failures: list[ProposalFailureV1]


class TrialV1(TypedDict):
    taskId: str
    repeatIndex: int
    status: str
    evidenceRef: NotRequired[ArtifactRef]
    receiptRef: NotRequired[ArtifactRef]
    code: NotRequired[str]


class EvaluationV1(TypedDict):
    schemaVersion: int
    subject: HarnessAgentV1
    taskViewRef: ArtifactRef
    status: str
    comparable: bool
    trials: list[TrialV1]
    evidenceRefs: list[ArtifactRef]
    comparisonKey: NotRequired[str]
    metrics: NotRequired[dict[str, float]]
    measurementRef: NotRequired[ArtifactRef]


class AuthorRoleGrantV1(TypedDict):
    template: str
    kind: str


class AuthorCapabilitiesV1(TypedDict):
    version: str
    lockDigest: str
    roles: dict[str, AuthorRoleGrantV1]
    operationLimits: dict[str, dict[str, int]]
    execution: dict[str, Any]


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("expected object", path)
    return value


def _exact(item: dict[str, Any], required: set[str], optional: set[str], path: str) -> None:
    for key in required - item.keys():
        raise ValidationError("required field missing", f"{path}.{key}")
    for key in item.keys() - required - optional:
        raise ValidationError("unexpected field", f"{path}.{key}")


def _digest(value: Any, path: str) -> None:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValidationError("expected SHA-256 digest", path)


def _nonnegative(value: Any, path: str) -> None:
    parsed = json_safe_integer(value)
    if parsed is None or parsed < 0:
        raise ValidationError("expected nonnegative safe integer", path)


def assert_artifact_ref(value: Any, *, schema_id: str | None = None, path: str = "$") -> None:
    item = _object(value, path)
    if item.get("kind") != "artifact" or ("schemaId" in item and
            (not isinstance(item["schemaId"], str) or not item["schemaId"])):
        raise ValidationError("artifact schema mismatch", path)
    if schema_id is not None and item.get("schemaId") != schema_id:
        raise ValidationError("artifact schema mismatch", path)
    if not isinstance(item.get("mediaType"), str) or not item["mediaType"]:
        raise ValidationError("artifact media type missing", path)
    _digest(item.get("digest"), f"{path}.digest")
    _nonnegative(item.get("size"), f"{path}.size")


def assert_binding_set_ref(value: Any, *, path: str = "$") -> None:
    item = _object(value, path)
    if item.get("kind") != "binding-set" or not isinstance(item.get("schemaId"), str) or not item["schemaId"]:
        raise ValidationError("binding-set schema missing", path)
    _digest(item.get("digest"), f"{path}.digest")


def assert_harness_agent_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.HarnessAgent")
    _exact(item, {"schemaVersion", "kind", "bindingSetRef", "executionProfileDigest"},
           {"proposalIndex"}, "$.HarnessAgent")
    if json_safe_integer(item["schemaVersion"]) != 1 or item["kind"] != "harness-agent":
        raise ValidationError("HarnessAgent version/kind invalid", "$.HarnessAgent")
    assert_binding_set_ref(item["bindingSetRef"], path="$.HarnessAgent.bindingSetRef")
    _digest(item["executionProfileDigest"], "$.HarnessAgent.executionProfileDigest")
    if "proposalIndex" in item:
        _nonnegative(item["proposalIndex"], "$.HarnessAgent.proposalIndex")


def assert_task_selection_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.TaskSelection")
    _exact(item, {"schemaVersion", "taskViewRef", "selectedTaskIds", "cursor"}, set(), "$.TaskSelection")
    if json_safe_integer(item["schemaVersion"]) != 1:
        raise ValidationError("TaskSelection version invalid", "$.TaskSelection")
    assert_artifact_ref(item["taskViewRef"], schema_id="task.view.v1", path="$.TaskSelection.taskViewRef")
    ids = item["selectedTaskIds"]
    if not isinstance(ids, list) or not ids or any(not isinstance(task_id, str) or not task_id for task_id in ids) or len(set(ids)) != len(ids):
        raise ValidationError("TaskSelection IDs invalid", "$.TaskSelection.selectedTaskIds")
    cursor = _object(item["cursor"], "$.TaskSelection.cursor")
    _exact(cursor, {"viewDigest", "nextIndex"}, set(), "$.TaskSelection.cursor")
    if cursor["viewDigest"] != item["taskViewRef"]["digest"] or json_safe_integer(cursor["nextIndex"]) != 0:
        raise ValidationError("TaskSelection cursor must start at selected view", "$.TaskSelection.cursor")


def assert_role_result_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.RoleResult")
    _exact(item, {"schemaVersion", "output", "evidenceRef", "receiptRef"}, set(), "$.RoleResult")
    if json_safe_integer(item["schemaVersion"]) != 1:
        raise ValidationError("RoleResult version invalid", "$.RoleResult")
    assert_artifact_ref(item["evidenceRef"], path="$.RoleResult.evidenceRef")
    assert_artifact_ref(item["receiptRef"], schema_id="execution.receipt.v1", path="$.RoleResult.receiptRef")


def decode_role_execution_result(value: Any, expected_binding_digest: str) -> RoleResultV1:
    """Project a host-verified execution result onto the author-facing role DTO.

    The Campaign's VerifiedExecutionAdapter verifies CAS bytes and receipts;
    this decoder checks the structural shape and binding identity during replay.
    """
    validate_json(value)
    item = _object(value, "$.ExecutionResult")
    if item.get("requestedBindingSetDigest") != expected_binding_digest:
        raise ValidationError("execution role binding identity changed", "$.ExecutionResult.requestedBindingSetDigest")
    actual_bindings = _object(item.get("actualBindings"), "$.ExecutionResult.actualBindings")
    for slot, ref in actual_bindings.items():
        assert_artifact_ref(ref, path=f"$.ExecutionResult.actualBindings.{slot}")
    if "structuredResult" not in item:
        raise ValidationError("execution role structured result missing", "$.ExecutionResult.structuredResult")
    assert_artifact_ref(item.get("evidenceRef"), path="$.ExecutionResult.evidenceRef")
    assert_artifact_ref(item.get("receiptRef"), schema_id="execution.receipt.v1",
                        path="$.ExecutionResult.receiptRef")
    assert_artifact_ref(item.get("structuredResultRef"), schema_id="execution.structured-result.v1",
                        path="$.ExecutionResult.structuredResultRef")
    result: RoleResultV1 = {"schemaVersion": 1, "output": item["structuredResult"],
                            "evidenceRef": item["evidenceRef"], "receiptRef": item["receiptRef"]}
    assert_role_result_v1(result)
    return result


def assert_proposal_batch_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.ProposalBatch")
    _exact(item, {"schemaVersion", "requestedCount", "candidates", "failures"}, set(), "$.ProposalBatch")
    if json_safe_integer(item["schemaVersion"]) != 1:
        raise ValidationError("ProposalBatch version invalid", "$.ProposalBatch")
    _nonnegative(item["requestedCount"], "$.ProposalBatch.requestedCount")
    if item["requestedCount"] == 0 or not isinstance(item["candidates"], list) or not isinstance(item["failures"], list):
        raise ValidationError("ProposalBatch count/outcomes invalid", "$.ProposalBatch")
    ordinals: list[int] = []
    previous_candidate = -1
    for candidate in item["candidates"]:
        assert_harness_agent_v1(candidate)
        if "proposalIndex" not in candidate:
            raise ValidationError("candidate ordinal missing", "$.ProposalBatch.candidates")
        if candidate["proposalIndex"] <= previous_candidate:
            raise ValidationError("candidate ordinals must ascend", "$.ProposalBatch.candidates")
        previous_candidate = candidate["proposalIndex"]
        ordinals.append(candidate["proposalIndex"])
    previous_failure = -1
    for failure in item["failures"]:
        failed = _object(failure, "$.ProposalFailure")
        _exact(failed, {"index", "stage", "code", "message", "evidenceRefs"},
               {"checkReportRef"}, "$.ProposalFailure")
        _nonnegative(failed["index"], "$.ProposalFailure.index")
        if failed["index"] <= previous_failure:
            raise ValidationError("failure ordinals must ascend", "$.ProposalBatch.failures")
        previous_failure = failed["index"]
        if failed["stage"] not in ("edit", "validation", "derive") or not isinstance(failed["code"], str) or not failed["code"] or not isinstance(failed["message"], str) or not isinstance(failed["evidenceRefs"], list):
            raise ValidationError("ProposalFailure fields invalid", "$.ProposalFailure")
        for ref in failed["evidenceRefs"]:
            assert_artifact_ref(ref, path="$.ProposalFailure.evidenceRefs")
        if "checkReportRef" in failed:
            assert_artifact_ref(failed["checkReportRef"], path="$.ProposalFailure.checkReportRef")
        ordinals.append(failed["index"])
    count = json_safe_integer(item["requestedCount"])
    if count is None or len(ordinals) != count or sorted(ordinals) != list(range(count)):
        raise ValidationError("ProposalBatch ordinals must partition requested count", "$.ProposalBatch")


def assert_author_capabilities_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.AuthorCapabilities")
    _exact(item, {"version", "lockDigest", "roles", "operationLimits", "execution"}, set(), "$.AuthorCapabilities")
    if item["version"] != AUTHOR_CAPABILITIES_VERSION:
        raise ValidationError("AuthorCapabilities version invalid", "$.AuthorCapabilities.version")
    _digest(item["lockDigest"], "$.AuthorCapabilities.lockDigest")
    for name, raw in _object(item["roles"], "$.AuthorCapabilities.roles").items():
        if _NAME.fullmatch(name) is None:
            raise ValidationError("invalid role name", f"$.AuthorCapabilities.roles.{name}")
        role = _object(raw, f"$.AuthorCapabilities.roles.{name}")
        _exact(role, {"template", "kind"}, set(), f"$.AuthorCapabilities.roles.{name}")
        if (role["template"], role["kind"]) not in (("read-only-analyst", "execution.role"),
                                                     ("harness-editor", "execution.workspace-edit")):
            raise ValidationError("role template/kind mismatch", f"$.AuthorCapabilities.roles.{name}")
    for kind, raw in _object(item["operationLimits"], "$.AuthorCapabilities.operationLimits").items():
        if _NAME.fullmatch(kind) is None:
            raise ValidationError("invalid operation kind", f"$.AuthorCapabilities.operationLimits.{kind}")
        limits = _object(raw, f"$.AuthorCapabilities.operationLimits.{kind}")
        if kind == "tasks.sample" and limits:
            raise ValidationError("tasks.sample is a pure operation and cannot carry limits",
                                  "$.AuthorCapabilities.operationLimits.tasks.sample")
        for dimension, limit in limits.items():
            _nonnegative(limit, f"$.AuthorCapabilities.operationLimits.{kind}.{dimension}")
    _object(item["execution"], "$.AuthorCapabilities.execution")


def assert_evaluation_v1(value: Any) -> None:
    validate_json(value)
    item = _object(value, "$.Evaluation")
    _exact(item, {"schemaVersion", "subject", "taskViewRef", "status", "comparable", "trials", "evidenceRefs"},
           {"comparisonKey", "metrics", "measurementRef"}, "$.Evaluation")
    if json_safe_integer(item["schemaVersion"]) != 1 or item["status"] not in ("complete", "incomplete", "invalid") or type(item["comparable"]) is not bool:
        raise ValidationError("Evaluation status invalid", "$.Evaluation")
    assert_harness_agent_v1(item["subject"])
    assert_artifact_ref(item["taskViewRef"], schema_id="task.view.v1", path="$.Evaluation.taskViewRef")
    if not isinstance(item["trials"], list) or not isinstance(item["evidenceRefs"], list):
        raise ValidationError("Evaluation trials/refs invalid", "$.Evaluation")
    for ref in item["evidenceRefs"]:
        assert_artifact_ref(ref, path="$.Evaluation.evidenceRefs")
    seen_trials: set[tuple[str, int]] = set()
    for trial in item["trials"]:
        row = _object(trial, "$.Evaluation.trial")
        _exact(row, {"taskId", "repeatIndex", "status"}, {"evidenceRef", "receiptRef", "code"}, "$.Evaluation.trial")
        if not isinstance(row["taskId"], str) or not row["taskId"] or row["status"] not in ("completed", "failed", "invalid"):
            raise ValidationError("Evaluation trial invalid", "$.Evaluation.trial")
        _nonnegative(row["repeatIndex"], "$.Evaluation.trial.repeatIndex")
        identity = (row["taskId"], row["repeatIndex"])
        if identity in seen_trials:
            raise ValidationError("Evaluation trial repeated", "$.Evaluation.trials")
        seen_trials.add(identity)
        for key in ("evidenceRef", "receiptRef"):
            if key in row:
                assert_artifact_ref(row[key], path=f"$.Evaluation.trial.{key}")
    if item["comparable"] != (item["status"] == "complete"):
        raise ValidationError("Evaluation complete/comparable mismatch", "$.Evaluation")
    if item["comparable"]:
        if not item["trials"] or not item["evidenceRefs"] or any(row["status"] != "completed" for row in item["trials"]):
            raise ValidationError("complete Evaluation requires completed trials and evidence", "$.Evaluation")
        _digest(item.get("comparisonKey"), "$.Evaluation.comparisonKey")
        assert_artifact_ref(item.get("measurementRef"), schema_id="measurement.record.v1", path="$.Evaluation.measurementRef")
        metrics = _object(item.get("metrics"), "$.Evaluation.metrics")
        if not metrics or any(type(number) not in (int, float) or not math.isfinite(number) for number in metrics.values()):
            raise ValidationError("Evaluation metrics invalid", "$.Evaluation.metrics")
    elif any(key in item for key in ("comparisonKey", "metrics", "measurementRef")):
        raise ValidationError("Incomplete Evaluation cannot publish aggregate metrics", "$.Evaluation")


__all__ = ["AUTHOR_CAPABILITIES_VERSION", "ArtifactRef", "BindingSetRef", "HarnessAgentV1",
           "TaskSelectionV1", "RoleResultV1", "ProposalFailureV1", "ProposalBatchV1", "TrialV1",
           "EvaluationV1", "AuthorRoleGrantV1", "AuthorCapabilitiesV1", "assert_artifact_ref",
           "assert_binding_set_ref", "assert_harness_agent_v1", "assert_task_selection_v1",
           "assert_role_result_v1", "decode_role_execution_result", "assert_proposal_batch_v1", "assert_evaluation_v1",
           "assert_author_capabilities_v1"]
