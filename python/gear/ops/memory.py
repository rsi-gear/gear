"""Compatibility imports; use the capability packages for new code."""

from gear.core._json import json_object as json_object
from gear.core._json import json_value as json_value
from gear.core.base import Module as Module
from gear.core.calls import ArtifactRef as ArtifactRef
from gear.core.calls import Call as Call
from gear.core.calls import checked_name as checked_name
from gear.core.candidates import FileContent as FileContent
from gear.core.candidates import TargetFiles as TargetFiles
from gear.core.stream import CompleteTask as CompleteTask
from gear.core.stream import CompleteTaskInput as CompleteTaskInput
from gear.memory.archive import ArchiveInput as ArchiveInput
from gear.memory.archive import UpdateArchive as UpdateArchive
from gear.memory.library import CommitLibrary as CommitLibrary
from gear.memory.library import CommitLibraryInput as CommitLibraryInput
from gear.memory.library import PublishLibrary as PublishLibrary
from gear.memory.library import PublishLibraryInput as PublishLibraryInput
from gear.memory.playbook import CounterDelta as CounterDelta
from gear.memory.playbook import MergePlaybook as MergePlaybook
from gear.memory.playbook import PlaybookDelta as PlaybookDelta
from gear.memory.playbook import PlaybookEntry as PlaybookEntry
from gear.memory.playbook import PlaybookInput as PlaybookInput
