"""Stable author API shared by every search recipe; no runtime or store imports."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from gear.canonical import JSON

OperationKind = Literal["diagnose_seed", "generate_candidate", "evaluate_seed", "nominate", "stop"]


@dataclass(frozen=True)
class Task:
    id: str
    family: str
    estimated_cost: float = 1.0


@dataclass(frozen=True)
class Candidate:
    id: str
    digest: str
    parent_id: str | None = None


@dataclass(frozen=True)
class Evidence:
    candidate_id: str
    task_id: str
    repetition: int
    score: float | None
    status: Literal["valid", "task_failed", "scoring_failed", "environment_failed"]
    scope: str
    feedback: str = ""
    raw_metrics: dict[str, JSON] | None = None
    assertions: list[dict[str, JSON]] | None = None
    verifier: dict[str, JSON] | None = None


@dataclass(frozen=True)
class Budget:
    evaluations_remaining: int
    candidates_remaining: int
    rounds: int
    repetitions: int = 1
    generation_requests_remaining: int | None = None
    generation_tokens_remaining: int | None = None
    generation_batch_capacity: int | None = None


@dataclass(frozen=True)
class OperationResult:
    operation_id: str
    kind: OperationKind
    status: Literal["complete", "failed"]
    candidate_id: str | None = None
    data: JSON = None


@dataclass(frozen=True)
class SearchView:
    run_id: str
    step_id: int
    seed: str
    tasks: tuple[Task, ...]
    candidates: tuple[Candidate, ...]
    evidence: tuple[Evidence, ...]
    completed: tuple[OperationResult, ...]
    budget: Budget
    anchor_id: str
    objective: JSON = None


@dataclass(frozen=True)
class AlgorithmState:
    version: int = 1
    data: dict[str, JSON] = field(default_factory=dict)


@dataclass(frozen=True)
class Operation:
    kind: OperationKind
    candidate_id: str | None = None
    parent_id: str | None = None
    task_ids: tuple[str, ...] = ()
    scope: str = "global"
    rationale: str = ""
    payload: JSON = None


@dataclass(frozen=True)
class ResearchRecord:
    """Seed-only policy trace, committed with its decision independently of promotion."""

    kind: Literal["scope", "ranking", "parents"]
    scope: str
    task_ids: tuple[str, ...]
    candidate_ids: tuple[str, ...]
    data: JSON


@dataclass(frozen=True)
class Decision:
    state: AlgorithmState
    operations: tuple[Operation, ...]
    reason: str
    research: tuple[ResearchRecord, ...] = ()


class SearchAlgorithm(Protocol):
    def step(self, view: SearchView, state: AlgorithmState) -> Decision: ...


@dataclass(frozen=True)
class ParentOption:
    candidate_id: str
    scope: str
    task_ids: tuple[str, ...]
    score: float
    probability: float = 1.0
    task_scores: tuple[tuple[str, float], ...] = ()
    weights: tuple[tuple[str, float], ...] = ()
    content_digest: str = ""


@dataclass(frozen=True)
class Selection:
    option: ParentOption
    probabilities: tuple[tuple[str, float], ...]
    random_index: int
    input_digest: str


@dataclass(frozen=True)
class ParentInput:
    eligible: tuple[ParentOption, ...]
    candidate_limit: int
    champion_id: str


@dataclass(frozen=True)
class ParentAllocation:
    selection: Selection
    count: int


@dataclass(frozen=True)
class ParentPlan:
    allocations: tuple[ParentAllocation, ...]
    reason: str

    @classmethod
    def single(cls, selection: Selection, count: int) -> ParentPlan:
        return cls((ParentAllocation(selection, count),), "selected parent")

    @classmethod
    def abstain(cls, reason: str) -> ParentPlan:
        return cls((), reason)


class ParentPolicy(Protocol):
    def __call__(self, view: ParentInput, rng: RandomSource) -> ParentPlan: ...


@dataclass(frozen=True)
class SamplingInput:
    tasks: tuple[Task, ...]
    failures: tuple[str, ...]
    stage: Literal["local", "bridge", "global"]
    required: tuple[str, ...] = ()
    successful_controls: tuple[str, ...] = ()


@dataclass(frozen=True)
class SamplingPlan:
    task_ids: tuple[str, ...]
    weights: tuple[tuple[str, float], ...]
    reason: str
    buckets: tuple[tuple[str, tuple[str, ...]], ...] = ()


class TaskSampler(Protocol):
    def __call__(self, view: SamplingInput, rng: RandomSource) -> SamplingPlan: ...


@dataclass(frozen=True)
class ProposalInput:
    parent: ParentOption
    failures: tuple[Evidence, ...]
    diagnosis: JSON
    candidate_limit: int
    tasks: tuple[Task, ...] = ()


@dataclass(frozen=True)
class ProposalPlan:
    hypotheses: tuple[str, ...]
    task_ids: tuple[str, ...]
    reason: str
    parent_candidate_id: str | None = None


class ProposalPlanner(Protocol):
    def __call__(self, view: ProposalInput) -> ProposalPlan: ...


@dataclass(frozen=True)
class RankingInput:
    candidate_ids: tuple[str, ...]
    task_ids: tuple[str, ...]
    evidence: tuple[Evidence, ...]
    repetitions: int
    weights: tuple[tuple[str, float], ...] = ()
    objective: JSON = None
    anchor_id: str = ""


@dataclass(frozen=True)
class RankingPlan:
    candidate_ids: tuple[str, ...]
    scores: tuple[tuple[str, float], ...]
    incomplete: tuple[str, ...]
    disqualified: tuple[str, ...] = ()


class CandidateRanker(Protocol):
    def __call__(self, view: RankingInput) -> RankingPlan: ...


class StopRule(Protocol):
    def __call__(self, view: SearchView, state: AlgorithmState) -> str | None: ...


class RandomSource(Protocol):
    def value(self, key: str, index: int = 0) -> float: ...
    def choice(
        self, options: tuple[ParentOption, ...], *, key: str, index: int = 0
    ) -> Selection: ...
