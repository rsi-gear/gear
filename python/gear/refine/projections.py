"""Internal frozen runtime projections."""

from __future__ import annotations

import json
import sys
from typing import Any


def main(request: dict[str, Any] | None = None) -> None:
    from gear.core.meta import parse_meta_result, prepare_meta
    from gear.evaluation.assertions import extract_assertions
    from gear.evaluation.objective import aggregate_metrics, extract_metrics, score_projection
    from gear.evaluation.projection import compare_candidates, project_candidate
    from gear.evaluation.verifier import bind_verifier_channels, project_verifier, verifier_feedback
    from gear.memory.experience import (
        experience_context,
        experience_query,
        experience_read,
        experience_read_plan,
        experience_record,
    )
    from gear.memory.research import project_research
    from gear.memory.trajectory import trajectory_page, trajectory_query
    from gear.refine.operator_effects import (
        operator_edits,
        operator_evidence,
        operator_history,
        operator_meta_prepare,
        operator_meta_result,
        operator_schema,
    )
    from gear.refine.training_policy import (
        offline_window,
        training_decide,
        training_dev_gate,
        training_pair,
    )

    operations = {
        "operator_schema": operator_schema,
        "operator_edits": operator_edits,
        "operator_meta_prepare": operator_meta_prepare,
        "operator_meta_result": operator_meta_result,
        "operator_history": operator_history,
        "operator_evidence": operator_evidence,
        "meta_prepare": prepare_meta,
        "meta_result": parse_meta_result,
        "assertions_extract": extract_assertions,
        "training_pair": training_pair,
        "training_dev_gate": training_dev_gate,
        "training_decide": training_decide,
        "offline_window": offline_window,
        "objective_extract": extract_metrics,
        "objective_aggregate": aggregate_metrics,
        "objective_score_projection": score_projection,
        "objective_project": project_candidate,
        "objective_compare": compare_candidates,
        "research_project": project_research,
        "experience_record": experience_record,
        "experience_query": experience_query,
        "experience_read": experience_read,
        "experience_read_plan": experience_read_plan,
        "experience_context": experience_context,
        "trajectory_query": trajectory_query,
        "trajectory_page": trajectory_page,
        "verifier_project": project_verifier,
        "verifier_feedback": verifier_feedback,
        "verifier_bind": bind_verifier_channels,
    }
    try:
        if request is None:
            request = json.load(sys.stdin)
        assert request is not None
        value = operations[request["operation"]](request["input"])
        reply = {"value": value}
    except (KeyError, TypeError, ValueError, RuntimeError) as error:
        reply = {"error": str(error), "type": type(error).__name__}
    print(json.dumps(reply, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
