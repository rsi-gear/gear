"""A complete Python-only diagnosis extension for GEPA.

Import ``algorithm`` from this module and pass it to ``Project.refine``.
The Meta policy and proposal planner are frozen by the public Python SDK.
"""

from dataclasses import dataclass

from gear.algorithms import (
    GEPA,
    MetaTask,
    Operation,
    ProposalInput,
    ProposalPlan,
    default_meta,
)


@dataclass(frozen=True)
class FailureAnalysis:
    focus: str = "reusable failure causes"

    def __call__(self, operation: Operation) -> MetaTask:
        if operation.kind == "generate_candidate":
            return default_meta(operation)
        return MetaTask(
            instructions=(
                f"Inspect the seed evidence for {self.focus}. Do not edit the candidate. "
                "Return findings as actionable improvements, ordered by expected usefulness."
            ),
            result_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "findings": {
                        "type": "array",
                        "maxItems": 8,
                        "items": {"type": "string", "minLength": 1, "maxLength": 2048},
                    },
                },
                "required": ["findings"],
            },
        )


def plan_findings(view: ProposalInput) -> ProposalPlan:
    diagnosis = view.diagnosis if isinstance(view.diagnosis, dict) else {}
    findings = diagnosis.get("findings", [])
    hypotheses = (
        tuple(item for item in findings if isinstance(item, str) and item.strip())
        if isinstance(findings, list)
        else ()
    )
    return ProposalPlan(
        hypotheses[: view.candidate_limit],
        tuple(sorted({cell.task_id for cell in view.failures})),
        "proposals from Python-owned diagnosis findings",
    )


algorithm = GEPA(meta_policy=FailureAnalysis(), proposal_planner=plan_findings)
