"""Random search varies proposals without failure-family prioritization."""

from ..contracts import ProposalInput, ProposalPlan


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    return ProposalPlan(
        tuple(
            f"Explore alternative {index + 1} using the permitted seed feedback."
            for index in range(view.candidate_limit)
        ),
        view.parent.task_ids,
        "independent exploratory proposals",
    )
