"""Composable failure-to-data operators; callers own conversion and execution."""

from gear.curriculum.cases import ExtractOutcomeCases
from gear.curriculum.contracts import (
    CheckResult,
    FailureMode,
    LearningTarget,
    MasteryObservation,
    ModelInput,
    OutcomeCase,
    OutcomeRecord,
    PracticeDraft,
    PracticePlan,
    PracticeSelection,
    TaskPoolPlan,
    ValidationEvidence,
    ValidationPlan,
    ValidationReport,
    ValidationResult,
)
from gear.curriculum.diagnosis import ContrastiveDiagnoser
from gear.curriculum.generation import GeneratePractice, PlanPractice
from gear.curriculum.memory import MergeFailureMemory
from gear.curriculum.selection import SelectLearningTargets, SelectPractice
from gear.curriculum.validation import ValidatePractice

__all__ = [
    "CheckResult",
    "ContrastiveDiagnoser",
    "ExtractOutcomeCases",
    "FailureMode",
    "GeneratePractice",
    "LearningTarget",
    "MasteryObservation",
    "MergeFailureMemory",
    "ModelInput",
    "OutcomeCase",
    "OutcomeRecord",
    "PlanPractice",
    "PracticeDraft",
    "PracticePlan",
    "PracticeSelection",
    "SelectLearningTargets",
    "SelectPractice",
    "TaskPoolPlan",
    "ValidatePractice",
    "ValidationEvidence",
    "ValidationPlan",
    "ValidationReport",
    "ValidationResult",
]
