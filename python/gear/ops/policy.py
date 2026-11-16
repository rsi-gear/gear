"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core.base import describe_module as describe_module
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import CandidateRef as CandidateRef
from gear.core.calls import checked_name as checked_name
from gear.core.policy import AccessPolicy as AccessPolicy
from gear.core.policy import ImportSource as ImportSource
from gear.core.policy import ScreeningPolicy as ScreeningPolicy
