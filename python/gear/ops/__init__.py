"""Compatibility author API; use core, evaluation, memory and search."""

from gear.core.artifacts import ArtifactInput as ArtifactInput
from gear.core.artifacts import ReadArtifact as ReadArtifact
from gear.core.artifacts import decode_artifact_pages as decode_artifact_pages
from gear.core.base import FunctionSpec as FunctionSpec
from gear.core.base import Module as Module
from gear.core.base import ModuleSpec as ModuleSpec
from gear.core.base import PureOperator as PureOperator
from gear.core.base import clone as clone
from gear.core.base import describe_module as describe_module
from gear.core.base import freeze_module as freeze_module
from gear.core.base import resource_bytes as resource_bytes
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import Call as Call
from gear.core.calls import CallRef as CallRef
from gear.core.calls import CallResult as CallResult
from gear.core.calls import CandidateRef as CandidateRef
from gear.core.calls import EffectOperator as EffectOperator
from gear.core.calls import Results as Results
from gear.core.candidates import ApplyEdits as ApplyEdits
from gear.core.candidates import ApplyInput as ApplyInput
from gear.core.candidates import CheckEdits as CheckEdits
from gear.core.candidates import EditCheck as EditCheck
from gear.core.candidates import EditCheckInput as EditCheckInput
from gear.core.candidates import EditPlan as EditPlan
from gear.core.candidates import FileContent as FileContent
from gear.core.candidates import FileEdit as FileEdit
from gear.core.candidates import GenerateCandidate as GenerateCandidate
from gear.core.candidates import GenerateInput as GenerateInput
from gear.core.candidates import MaterializeCandidate as MaterializeCandidate
from gear.core.candidates import MaterializeInput as MaterializeInput
from gear.core.candidates import TargetFiles as TargetFiles
from gear.core.candidates import content_digest as content_digest
from gear.core.composition import ModuleStep as ModuleStep
from gear.core.composition import Sequential as Sequential
from gear.core.composition import StepModule as StepModule
from gear.core.meta import Meta as Meta
from gear.core.meta import MetaInput as MetaInput
from gear.core.policy import AccessPolicy as AccessPolicy
from gear.core.policy import ImportSource as ImportSource
from gear.core.policy import ScreeningPolicy as ScreeningPolicy
from gear.core.state import StateTree as StateTree
from gear.core.stream import CompleteTask as CompleteTask
from gear.core.stream import CompleteTaskInput as CompleteTaskInput
from gear.evaluation.operators import CompareCandidates as CompareCandidates
from gear.evaluation.operators import ComparisonInput as ComparisonInput
from gear.evaluation.operators import ComparisonPlan as ComparisonPlan
from gear.evaluation.operators import ComparisonResult as ComparisonResult
from gear.evaluation.operators import Evaluate as Evaluate
from gear.evaluation.operators import EvidenceRecord as EvidenceRecord
from gear.evaluation.operators import EvidenceSet as EvidenceSet
from gear.evaluation.operators import EvidenceSetSpec as EvidenceSetSpec
from gear.evaluation.operators import ExecutionInput as ExecutionInput
from gear.evaluation.operators import ReadEvidence as ReadEvidence
from gear.evaluation.operators import ReadEvidenceInput as ReadEvidenceInput
from gear.evaluation.operators import Rollout as Rollout
from gear.evaluation.operators import SamplePlan as SamplePlan
from gear.evaluation.operators import Score as Score
from gear.evaluation.operators import ScoreInput as ScoreInput
from gear.evaluation.operators import SelectEvidence as SelectEvidence
from gear.evaluation.operators import TaskSamples as TaskSamples
from gear.evaluation.tasks import Task as Task
from gear.memory.archive import ArchiveInput as ArchiveInput
from gear.memory.archive import UpdateArchive as UpdateArchive
from gear.memory.history import HistoryInput as HistoryInput
from gear.memory.history import QueryHistory as QueryHistory
from gear.memory.library import CommitLibrary as CommitLibrary
from gear.memory.library import CommitLibraryInput as CommitLibraryInput
from gear.memory.library import PublishLibrary as PublishLibrary
from gear.memory.library import PublishLibraryInput as PublishLibraryInput
from gear.memory.playbook import CounterDelta as CounterDelta
from gear.memory.playbook import MergePlaybook as MergePlaybook
from gear.memory.playbook import PlaybookDelta as PlaybookDelta
from gear.memory.playbook import PlaybookEntry as PlaybookEntry
from gear.memory.playbook import PlaybookInput as PlaybookInput
from gear.search.api import Algorithm as Algorithm
from gear.search.api import SearchAlgorithm as SearchAlgorithm
from gear.search.api import SearchView as SearchView
from gear.search.decisions import Decision as Decision
from gear.search.decisions import Terminal as Terminal
from gear.search.screening import InterpretScreen as InterpretScreen
from gear.search.screening import ScreenCheckInput as ScreenCheckInput
from gear.search.screening import ScreenedEvaluate as ScreenedEvaluate
from gear.search.screening import ScreenInput as ScreenInput
from gear.search.screening import ScreenResult as ScreenResult
from gear.search.screening import ScreenVerdict as ScreenVerdict

__all__ = [
    "decode_artifact_pages",
    "Algorithm",
    "SearchAlgorithm",
    "SearchView",
    "Task",
    "ArtifactInput",
    "ArtifactRef",
    "Call",
    "CallRef",
    "CallResult",
    "CandidateRef",
    "Decision",
    "EffectOperator",
    "FunctionSpec",
    "HistoryInput",
    "Meta",
    "MetaInput",
    "Module",
    "ModuleSpec",
    "PureOperator",
    "QueryHistory",
    "ReadArtifact",
    "Results",
    "StateTree",
    "ScreeningPolicy",
    "AccessPolicy",
    "ImportSource",
    "TargetFiles",
    "Terminal",
    "clone",
    "describe_module",
    "freeze_module",
    "resource_bytes",
    "ApplyEdits",
    "ApplyInput",
    "CheckEdits",
    "EditCheck",
    "EditCheckInput",
    "EditPlan",
    "FileContent",
    "FileEdit",
    "GenerateCandidate",
    "GenerateInput",
    "MaterializeCandidate",
    "MaterializeInput",
    "content_digest",
    "InterpretScreen",
    "ModuleStep",
    "ScreenCheckInput",
    "ScreenedEvaluate",
    "ScreenInput",
    "ScreenResult",
    "ScreenVerdict",
    "Sequential",
    "StepModule",
    "CompareCandidates",
    "ComparisonInput",
    "ComparisonPlan",
    "ComparisonResult",
    "Evaluate",
    "EvidenceRecord",
    "EvidenceSet",
    "EvidenceSetSpec",
    "ExecutionInput",
    "ReadEvidence",
    "ReadEvidenceInput",
    "Rollout",
    "SamplePlan",
    "Score",
    "ScoreInput",
    "SelectEvidence",
    "TaskSamples",
    "ArchiveInput",
    "CommitLibrary",
    "CommitLibraryInput",
    "CompleteTask",
    "CompleteTaskInput",
    "CounterDelta",
    "MergePlaybook",
    "PlaybookDelta",
    "PlaybookEntry",
    "PlaybookInput",
    "PublishLibrary",
    "PublishLibraryInput",
    "UpdateArchive",
]
