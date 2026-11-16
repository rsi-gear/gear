"""Compatibility imports; use the capability packages for new code."""

from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import CandidateRef as CandidateRef
from gear.core.candidates import ApplyEdits as ApplyEdits
from gear.core.candidates import ApplyInput as ApplyInput
from gear.core.candidates import EditPlan as EditPlan
from gear.core.candidates import FileContent as FileContent
from gear.core.candidates import FileEdit as FileEdit
from gear.core.schema import validate_output as validate_output
from gear.core.schema import validate_schema as validate_schema
from gear.evaluation.operators import EvidenceSetSpec as EvidenceSetSpec
from gear.evaluation.operators import TaskSamples as TaskSamples
from gear.refine.operator_effects import operator_edits as operator_edits
from gear.refine.operator_effects import operator_evidence as operator_evidence
from gear.refine.operator_effects import operator_history as operator_history
from gear.refine.operator_effects import operator_meta_prepare as operator_meta_prepare
from gear.refine.operator_effects import operator_meta_result as operator_meta_result
from gear.refine.operator_effects import operator_schema as operator_schema
