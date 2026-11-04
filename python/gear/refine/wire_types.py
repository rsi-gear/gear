"""Generated transport types. Author contracts live in algorithms/contracts.py."""
from __future__ import annotations
from typing import Literal, TypedDict, TypeAlias
from gear.canonical import JSON as Json

class Task(TypedDict):
    id: str
    family: str
    estimated_cost: float

class Candidate(TypedDict):
    id: str
    digest: str
    parent_id: str | None

class _EvidenceRequired(TypedDict):
    candidate_id: str
    task_id: str
    repetition: int
    score: float | None
    status: Literal["valid", "task_failed", "scoring_failed", "environment_failed"]
    scope: str
    feedback: str

class Evidence(_EvidenceRequired, total=False):
    raw_metrics: dict[str, RawMetricValue] | None
    assertions: list[AssertionEvidence] | None
    verifier: VerifierObservation | None

class _BudgetRequired(TypedDict):
    evaluations_remaining: int
    candidates_remaining: int
    rounds: int
    repetitions: int

class Budget(_BudgetRequired, total=False):
    generation_requests_remaining: int | None
    generation_tokens_remaining: int | None
    generation_batch_capacity: int | None
OperationKind: TypeAlias = Literal["diagnose_seed", "generate_candidate", "evaluate_seed", "nominate", "stop", "workspace_open", "workspace_edit", "workspace_seal", "workspace_discard", "workspace_apply", "artifact_list", "artifact_read", "artifact_diff", "artifact_trial_read", "artifact_material"]

class _OperationResultRequired(TypedDict):
    operation_id: str
    kind: OperationKind
    status: Literal["complete", "failed"]
    candidate_id: str | None
    data: Json

class OperationResult(_OperationResultRequired, total=False):
    candidate_change: Json

class _SearchViewRequired(TypedDict):
    run_id: str
    step_id: int
    seed: str
    tasks: list[Task]
    candidates: list[Candidate]
    evidence: list[Evidence]
    completed: list[OperationResult]
    budget: Budget
    anchor_id: str

class SearchView(_SearchViewRequired, total=False):
    objective: Json
    research_trials: list[ResearchTrial]
    research_data: Json

class AlgorithmState(TypedDict):
    version: Literal[1]
    data: dict[str, Json]

class Operation(TypedDict):
    kind: OperationKind
    candidate_id: str | None
    parent_id: str | None
    task_ids: list[str]
    scope: str
    rationale: str
    payload: Json

class _DecisionRequired(TypedDict):
    state: AlgorithmState
    operations: list[Operation]
    reason: str

class Decision(_DecisionRequired, total=False):
    research: list[ResearchRecord]

class WorkerRequest(TypedDict):
    protocol_version: Literal[1]
    request_id: str
    run_id: str
    step_id: int
    input_digest: str
    method: Literal["handshake", "step"]
    payload: Json

class WorkerResponse(TypedDict):
    protocol_version: Literal[1]
    request_id: str
    run_id: str
    step_id: int
    input_digest: str
    result: Json
    error: dict[str, Json] | None

class _OperationReceiptRequired(TypedDict):
    result: OperationResult
    evidence: list[Evidence]
    candidate: Candidate | None
    physicalAttempts: int
    usage: dict[str, float | None]
    provenance: Json

class OperationReceipt(_OperationReceiptRequired, total=False):
    artifacts: list[TrialArtifact]
    trial_details: list[TrialDetail]

class _RawMetricValueRequired(TypedDict):
    contractDigest: str
    unit: str
    status: Literal["available", "missing", "invalid", "unsupported"]
    evidenceRefs: list[str]

class RawMetricValue(_RawMetricValueRequired, total=False):
    value: float
    reason: str

class _AssertionEvidenceRequired(TypedDict):
    id: str
    schemaDigest: str
    status: Literal["passed", "failed", "excluded", "missing", "invalid", "unsupported"]
    evidenceRefs: list[str]

class AssertionEvidence(_AssertionEvidenceRequired, total=False):
    reason: str

class ResearchRecord(TypedDict):
    kind: Literal["scope", "ranking", "parents"]
    scope: str
    task_ids: list[str]
    candidate_ids: list[str]
    data: Json

class TrialArtifact(TypedDict):
    kind: Literal["trajectory"]
    format: str
    task_id: str
    repetition: int
    status: Literal["available", "unavailable"]
    content_digest: str | None
    locator: Json
    reason: str | None

class VerifierComponent(TypedDict):
    id: str
    category: str
    status: Literal["passed", "failed", "excluded"]
    weight: float
    code: str | None
    public_details: Json
    details_omitted: bool

class VerifierFeedback(TypedDict):
    code: str
    severity: Literal["info", "warning", "error"]
    message: str
    message_truncated: bool
    component_ids: list[str]
    omitted_component_ids: int

class VerifierProcess(TypedDict):
    metric: str
    score: float
    detail_status: Literal["components", "aggregate-only"]
    passed: int | None
    total: int | None
    excluded: int | None
    components: list[VerifierComponent]
    omitted_components: int
    artifact_digest: str

class VerifierObservation(TypedDict):
    version: Literal[1]
    status: Literal["available", "missing", "invalid", "unsupported", "unavailable"]
    reason: str | None
    source_digest: str | None
    result_digest: str | None
    primary_score: float | None
    detail_status: Literal["complete", "result_only"] | None
    process: VerifierProcess | None
    feedback: list[VerifierFeedback]
    omitted_feedback: int
    failure_codes: list[str]
    omitted_failure_codes: int

class TrialDetail(TypedDict):
    task_id: str
    repetition: int
    output: str | None
    usage: Json
    execution_status: str | None

class ResearchTrial(TypedDict):
    id: str
    operation_id: str
    group: str
    instance_id: str
    task_id: str
    repetition: int
    candidate_id: str
    input_digest: str
    evidence: Evidence
    output: str | None
    usage: Json
    execution_status: str | None
    artifacts: list[TrialArtifact]
