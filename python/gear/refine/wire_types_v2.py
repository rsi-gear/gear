"""Generated transport types. Author contracts live in ops/."""
from __future__ import annotations
from typing import Literal, TypedDict, TypeAlias
from gear.canonical import JSON as Json
Digest: TypeAlias = str
Name: TypeAlias = str

class CandidateRef(TypedDict):
    run_id: Name
    candidate_id: str
    digest: Digest

class ArtifactRef(TypedDict):
    run_id: Name
    kind: Name
    digest: Digest
    visibility: Literal["agent", "optimization", "evaluation_private", "mixed"]
SourceRef: TypeAlias = CandidateRef | ArtifactRef

class CallRef(TypedDict):
    key: Name
    request_digest: Digest

class OperatorRef(TypedDict):
    entrypoint: Name
    configuration_digest: Digest

class FunctionSpec(TypedDict):
    kind: Literal["function"]
    entrypoint: Name
    source_dependencies: list[list[str]]
    package_dependencies: list[Name]
    resources: list[list[str]]

class ModuleSpec(TypedDict):
    kind: Literal["module"]
    entrypoint: Name
    source_dependencies: list[list[str]]
    package_dependencies: list[Name]
    resources: list[list[str]]
    params: dict[str, Json]
    children: dict[str, ComponentSpec]
    state_schema_version: int
ComponentSpec: TypeAlias = ModuleSpec | FunctionSpec

class SchemaRef(TypedDict):
    digest: Digest
    schema: dict[str, Json]

class FileContent(TypedDict):
    content: str
    executable: bool
    encoding: Literal["utf-8", "base64"]

class FileEdit(TypedDict):
    operation: Literal["create", "replace", "delete", "patch"]
    path: str
    expected_digest: Digest | None
    content: FileContent | None
    blob: ArtifactRef | None
    patch: str | None
    executable: bool | None

class EditPlan(TypedDict):
    edits: list[FileEdit]

class TaskSamples(TypedDict):
    task_id: Name
    slots: list[int]

class SamplePlan(TypedDict):
    tasks: list[TaskSamples]
    mode: Literal["ensure", "fresh", "reuse"]
    plan_id: Name | None
    evidence_set: ArtifactRef | None
    randomness: Literal["provider", "controlled", "paired"]
    seed: Name | None

class EvidenceSetSpec(TypedDict):
    candidate: CandidateRef
    assessments: list[ArtifactRef]
    tasks: list[TaskSamples]
    task_weights: list[list[Json]]
    objective_ref: Digest
    reducer_ref: Name
    missing_policy: Literal["incomplete"]

class MetaInput(TypedDict):
    candidate: CandidateRef
    task_ids: list[Name]
    sources: list[SourceRef]
    data: Json
    prompt: str
    schema: dict[str, Json]
    max_tokens: int | None

class GenerateInput(TypedDict):
    mode: Literal["model"]
    base: CandidateRef
    instruction: str
    task_ids: list[Name]
    sources: list[SourceRef]
    data: Json
    max_tokens: int | None

class MaterializeInput(TypedDict):
    mode: Literal["edits"]
    base: CandidateRef
    plan: EditPlan
    sources: list[SourceRef]

class ArtifactRead(TypedDict):
    view: Literal["artifact"]
    ref: SourceRef
    path: str | None
    cursor: Name | None
    max_bytes: int

class HistoryRead(TypedDict):
    view: Literal["history"]
    snapshot: ArtifactRef
    query: Json
    cursor: Name | None
    limit: int

class EvidenceRead(TypedDict):
    view: Literal["evidence"]
    spec: EvidenceSetSpec
    cursor: Name | None
    limit: int

class ExecutionInput(TypedDict):
    candidate: CandidateRef
    plan: SamplePlan
    assets: list[ArtifactRef]
    parameters: Json
    screening: CallRef | None
    mode: Literal["scored", "scored_private", "unscored"]
    exposure: Literal["scored", "blind"]
    metrics: list[Name]

class ScoreInput(TypedDict):
    execution: ArtifactRef
    scorer: ArtifactRef

class LibraryCommit(TypedDict):
    mode: Literal["commit"]
    base: ArtifactRef | None
    assets: dict[str, ArtifactRef]
    data: Json

class LibraryPublish(TypedDict):
    mode: Literal["publish"]
    name: Name
    snapshot: ArtifactRef
    expected_revision: Name | None

class CompleteTaskInput(TypedDict):
    task_id: Name
    sample_id: Name
    output: ArtifactRef
    expected_revision: Name
    library_refs: list[ArtifactRef]

class MetaEffect(TypedDict):
    kind: Literal["meta"]
    input: MetaInput

class CandidateEffect(TypedDict):
    kind: Literal["candidate"]
    input: GenerateInput | MaterializeInput

class ReadEffect(TypedDict):
    kind: Literal["read"]
    input: ArtifactRead | HistoryRead | EvidenceRead

class ExecuteEffect(TypedDict):
    kind: Literal["execute"]
    input: ExecutionInput

class ScoreEffect(TypedDict):
    kind: Literal["score"]
    input: ScoreInput

class LibraryEffect(TypedDict):
    kind: Literal["library"]
    input: LibraryCommit | LibraryPublish

class StreamEffect(TypedDict):
    kind: Literal["stream"]
    input: CompleteTaskInput
EffectRequest: TypeAlias = MetaEffect | CandidateEffect | ReadEffect | ExecuteEffect | ScoreEffect | LibraryEffect | StreamEffect

class Call(TypedDict):
    key: Name
    operator_ref: OperatorRef
    effect: EffectRequest
    output_schema_ref: SchemaRef

class CallResult(TypedDict):
    ref: CallRef
    status: Literal["succeeded", "failed", "cancelled"]
    value: Json
    error: dict[str, Json] | None
    artifacts: list[ArtifactRef]
    usage: dict[str, Json] | None

class AlgorithmState(TypedDict):
    version: int
    data: dict[str, Json]
Terminal: TypeAlias = dict[str, Json] | dict[str, Json]

class Decision(TypedDict):
    state: AlgorithmState
    calls: list[Call]
    reason: str
    terminal: Terminal | None
    records: list[dict[str, Json]]

class Task(TypedDict):
    id: Name
    family: Name
    estimated_cost: float
    input: Json

class SearchView(TypedDict):
    run_id: Name
    step_id: int
    seed: str
    tasks: list[Task]
    candidates: list[CandidateRef]
    results: list[CallResult]
    budget: dict[str, Json]
    anchor: CandidateRef
    objective: Json
    history: ArtifactRef | None
    stream: Json
    assets: list[ArtifactRef]
    capabilities: list[Name]

class WorkerRequest(TypedDict):
    protocol_version: Literal[2]
    request_id: str
    run_id: str
    step_id: int
    input_digest: Digest
    method: Literal["handshake", "step", "screen"]
    payload: Json

class WorkerResponse(TypedDict):
    protocol_version: Literal[2]
    request_id: str
    run_id: str
    step_id: int
    input_digest: Digest
    result: Json
    error: dict[str, Json] | None
