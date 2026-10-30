"""Meta-Harness adaptation using Gear's archive-aware Meta operations."""

from ..workflow import StagedSearch
from .parents import select_best_parent
from .proposal import plan_proposals
from .ranking import rank_candidates
from .sampling import sample_all_tasks
from .stopping import stop_reason


class MetaHarness(StagedSearch):
    """Search one global candidate at a time using the complete seed archive.

    Gear's Meta worker owns filesystem access to prior candidate artifacts and
    traces. This policy keeps the search loop deterministic and asks that worker
    to ground each edit in that history; it does not itself read local files.
    """

    def __init__(self) -> None:
        super().__init__(
            select_best_parent,
            sample_all_tasks,
            plan_proposals,
            rank_candidates,
            stop_reason,
            ("global",),
            (),
        )
