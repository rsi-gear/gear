"""Meta-Harness prompts and algorithm-specific diagnosis validation."""

from typing import cast

from gear.canonical import JSON

from ..contracts import ProposalInput, ProposalPlan

HISTORY_GUIDANCE = (
    "Inspect the bounded, read-only seed archive, including baseline evidence, all evaluated "
    "candidate scores, complete historical source pages, and successful and failed trajectories. "
    "Choose a useful prior mechanism based on that evidence; do not restrict the search to a "
    "failure family or the highest-scoring parent. Keep the change generalizable and do not access "
    "held-out data."
)

GENERATION_SCHEMA: dict[str, JSON] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}


def diagnosis_meta(base_candidates: list[dict[str, JSON]]) -> dict[str, JSON]:
    """Build this algorithm's response contract from its currently eligible archive."""
    candidate_ids = [item.get("candidate_id") for item in base_candidates]
    if (
        not candidate_ids
        or any(not isinstance(item, str) or not item for item in candidate_ids)
        or len(set(candidate_ids)) != len(candidate_ids)
    ):
        raise ValueError("Meta-Harness requires distinct, eligible historical bases")
    return {
        "prompt": (
            HISTORY_GUIDANCE
            + " Read the full source for any useful earlier candidate through paginated source pages. "
            "Choose one candidate ID from operation.payload.base_candidates as base_candidate_id, "
            "then propose exactly one general mechanism in hypothesis. Consider all diagnosis "
            "clusters and hypotheses, including successful mechanisms that can be reused. Continue "
            "even if every seed task currently passes. Return summary, base_candidate_id, and "
            "hypothesis in the requested JSON object."
        ),
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "summary": {"type": "string", "minLength": 1},
                "base_candidate_id": {"type": "string", "enum": cast(list[str], candidate_ids)},
                "hypothesis": {"type": "string", "minLength": 1},
            },
            "required": ["summary", "base_candidate_id", "hypothesis"],
        },
    }


def generation_meta(hypothesis: str) -> dict[str, JSON]:
    return {
        "prompt": (
            "Implement exactly one general-purpose mechanism in the selected historical base. "
            "Preserve mechanisms that work, change only authorized files, and do not add task- or "
            "benchmark-specific hints. Do not run evaluations or inspect held-out data. Proposed "
            "mechanism: "
            + hypothesis
        ),
        "schema": GENERATION_SCHEMA,
    }


def parse_diagnosis(result: JSON, eligible_base_ids: tuple[str, ...]) -> dict[str, JSON] | None:
    """Validate the custom Meta response and ensure its parent is authorized in Python."""
    if (
        not isinstance(result, dict)
        or set(result) != {"declined", "data"}
        or type(result["declined"]) is not bool
    ):
        raise ValueError("Meta-Harness received an invalid Meta result envelope")
    if result["declined"]:
        return None
    data = result["data"]
    if (
        not isinstance(data, dict)
        or set(data) != {"summary", "base_candidate_id", "hypothesis"}
        or not isinstance(data["summary"], str)
        or not data["summary"].strip()
        or not isinstance(data["base_candidate_id"], str)
        or data["base_candidate_id"] not in eligible_base_ids
        or not isinstance(data["hypothesis"], str)
        or not data["hypothesis"].strip()
    ):
        raise ValueError("Meta-Harness diagnosis selected an invalid or ineligible base")
    return cast(dict[str, JSON], data)


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    diagnosis = view.diagnosis
    if (
        not isinstance(diagnosis, dict)
        or set(diagnosis) != {"summary", "base_candidate_id", "hypothesis"}
        or not isinstance(diagnosis.get("summary"), str)
        or not isinstance(diagnosis.get("hypothesis"), str)
    ):
        raise ValueError("Meta-Harness proposal requires a validated diagnosis")
    summary = cast(str, diagnosis["summary"]).strip()
    hypothesis = cast(str, diagnosis["hypothesis"]).strip()
    if not summary or not hypothesis or view.candidate_limit < 1:
        return ProposalPlan((), (), "diagnosis declined or generation budget exhausted")
    task_ids = tuple(sorted(task.id for task in view.tasks))
    return ProposalPlan(
        (summary + "\nSelected mechanism: " + hypothesis,),
        task_ids,
        HISTORY_GUIDANCE,
    )
