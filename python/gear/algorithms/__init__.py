"""Stable algorithm author API. Every recipe uses the same replaceable contracts."""

import sys as _sys

from gear.refine import testkit
from gear.refine.contracts import (
    AlgorithmState,
    Budget,
    Candidate,
    CandidateRanker,
    Decision,
    Evidence,
    Operation,
    OperationResult,
    ParentAllocation,
    ParentInput,
    ParentOption,
    ParentPlan,
    ParentPolicy,
    ProposalInput,
    ProposalPlan,
    ProposalPlanner,
    RandomSource,
    RankingInput,
    RankingPlan,
    ResearchRecord,
    ResearchTrial,
    SamplingInput,
    SamplingPlan,
    SearchAlgorithm,
    SearchView,
    Selection,
    StopRule,
    Task,
    TaskSampler,
)
from gear.refine.random import DeterministicRandom
from gear.refine.run_context import (
    EvaluationResult,
    EvidencePage,
    Role,
    RoleResult,
    RunContext,
    RunData,
    RunInputs,
    TaskInstance,
    TrialResult,
    WorkflowAlgorithm,
    WorkflowResult,
)
from gear.refine.workspaces import WorkspaceRef

from .adas import ADAS
from .gepa import GEPA
from .random_search import RandomSearch

# Existing custom algorithms use this documented authoring entrypoint.
_sys.modules[__name__ + ".testkit"] = testkit

__all__ = [
    "ADAS",
    "WorkspaceRef",
    "AlgorithmState",
    "Budget",
    "Candidate",
    "CandidateRanker",
    "Decision",
    "Evidence",
    "Operation",
    "OperationResult",
    "ParentAllocation",
    "ParentInput",
    "ParentOption",
    "ParentPlan",
    "ParentPolicy",
    "ProposalInput",
    "ProposalPlan",
    "ProposalPlanner",
    "RandomSource",
    "RankingInput",
    "RankingPlan",
    "ResearchRecord",
    "ResearchTrial",
    "SamplingInput",
    "SamplingPlan",
    "SearchAlgorithm",
    "SearchView",
    "Selection",
    "StopRule",
    "Task",
    "TaskSampler",
    "DeterministicRandom",
    "GEPA",
    "RandomSearch",
    "EvaluationResult",
    "EvidencePage",
    "Role",
    "RoleResult",
    "RunContext",
    "RunData",
    "RunInputs",
    "WorkflowAlgorithm",
    "WorkflowResult",
    "TaskInstance",
    "TrialResult",
]
