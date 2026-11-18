"""Gear SDK and independently importable algorithm engineering capabilities."""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .project import Project, ProjectError, Report, Run

__version__ = "0.2.2"
__all__ = ["Project", "ProjectError", "Report", "Run"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import project

        value = getattr(project, name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
