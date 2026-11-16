"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core._json import json_value as json_value
from gear.core.base import _CHILD as _CHILD
from gear.core.base import _DICT as _DICT
from gear.core.base import _TUPLE as _TUPLE
from gear.core.base import FunctionSpec as FunctionSpec
from gear.core.base import InputT as InputT
from gear.core.base import Module as Module
from gear.core.base import ModuleSpec as ModuleSpec
from gear.core.base import OutputT as OutputT
from gear.core.base import PureOperator as PureOperator
from gear.core.base import _component as _component
from gear.core.base import _declarations as _declarations
from gear.core.base import _parameters as _parameters
from gear.core.base import _segment as _segment
from gear.core.base import clone as clone
from gear.core.base import construct_module as construct_module
from gear.core.base import describe_module as describe_module
from gear.core.base import entrypoint as entrypoint
from gear.core.base import freeze_module as freeze_module
from gear.core.base import required_capabilities as required_capabilities
from gear.core.base import resource_bytes as resource_bytes
from gear.search.contracts_v1 import RandomSource as RandomSource
