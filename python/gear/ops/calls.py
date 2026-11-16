"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core._json import json_value as json_value
from gear.core.calls import EFFECTS as EFFECTS
from gear.core.calls import MAX_CALL_BYTES as MAX_CALL_BYTES
from gear.core.calls import SHA_PATTERN as SHA_PATTERN
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import Call as Call
from gear.core.calls import CallRef as CallRef
from gear.core.calls import CallResult as CallResult
from gear.core.calls import CandidateRef as CandidateRef
from gear.core.calls import DecodedT as DecodedT
from gear.core.calls import EffectKind as EffectKind
from gear.core.calls import EffectOperator as EffectOperator
from gear.core.calls import InputT as InputT
from gear.core.calls import OutputT as OutputT
from gear.core.calls import Results as Results
from gear.core.calls import T as T
from gear.core.calls import checked_digest as checked_digest
from gear.core.calls import checked_name as checked_name
from gear.core.schema import validate_schema as validate_schema
from gear.core.wire import validate_v2 as validate_v2
from gear.search.decisions import Decision as Decision
from gear.search.decisions import Terminal as Terminal
