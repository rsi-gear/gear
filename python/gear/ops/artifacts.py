"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core.artifacts import ArtifactInput as ArtifactInput
from gear.core.artifacts import ReadArtifact as ReadArtifact
from gear.core.artifacts import decode_artifact_pages as decode_artifact_pages
from gear.core.artifacts import relative_path as relative_path
from gear.core.base import Module as Module
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import Call as Call
from gear.core.calls import CandidateRef as CandidateRef
from gear.memory.history import HistoryInput as HistoryInput
from gear.memory.history import QueryHistory as QueryHistory
