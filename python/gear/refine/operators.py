"""Fixed Python projections used by the Project and training execution adapters.

Algorithm decisions use the public author contracts and durable workflow context.
Only current pure projections are exposed on this internal transport.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def main(request: dict[str, Any] | None = None) -> None:
    from gear.observations.trajectory import trajectory_page, trajectory_query
    from gear.training.policy import (
        offline_window,
        training_decide,
        training_dev_gate,
        training_pair,
    )

    from .assertions import extract_assertions
    from .experience import (
        experience_context,
        experience_query,
        experience_read,
        experience_read_plan,
        experience_record,
    )
    from .meta import parse_meta_result, prepare_meta
    from .objective import aggregate_metrics, extract_metrics, score_projection
    from .projection import compare_candidates, project_candidate
    from .research import project_research
    from .verifier import bind_verifier_channels, project_verifier, verifier_feedback

    operations = {
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
