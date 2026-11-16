"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core.artifacts import relative_path as relative_path
from gear.core.base import Module as Module
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import Call as Call
from gear.core.calls import CandidateRef as CandidateRef
from gear.core.calls import checked_digest as checked_digest
from gear.core.calls import checked_name as checked_name
from gear.core.candidates import _HUNK as _HUNK
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
from gear.core.candidates import content_digest as content_digest
from gear.core.candidates import exact_patch as exact_patch
