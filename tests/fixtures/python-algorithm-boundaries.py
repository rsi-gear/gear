"""Acceptance cases distilled from PR #95 (f0e7339) and #99 (e7ce69d).

Only the algorithm/runtime boundary is exercised, not full paper reproduction.
Screening is an algorithm decision; it never manufactures evaluation evidence.
"""

import re
from dataclasses import replace

from gear.algorithms import AlgorithmState, Decision, Operation


class HistoricalBase:
    def __init__(self, result_key="base_candidate_id"):
        self.result_key = result_key
        self.configuration = {"result_key": result_key}

    def step(self, view, state):
        if not view.completed:
            bases = [
                {"candidate_id": cell.candidate_id, "score": cell.score}
                for cell in view.evidence
            ]
            return Decision(
                state,
                (
                    Operation(
                        "diagnose_seed",
                        candidate_id="anchor",
                        task_ids=("seed",),
                        payload={
                            "base_candidates": bases,
                            "meta": {
                                "prompt": "Choose a useful historical base, even when all tasks passed.",
                                "schema": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        self.result_key: {
                                            "type": "string",
                                            "enum": [
                                                base["candidate_id"] for base in bases
                                            ],
                                        }
                                    },
                                    "required": [self.result_key],
                                },
                            },
                        },
                    ),
                ),
                "compare historical bases",
            )
        result = view.completed[-1]
        if result.status != "complete":
            raise ValueError("Meta did not complete")
        response = result.data["data"]
        eligible = {cell.candidate_id for cell in view.evidence}
        if (
            not isinstance(response, dict)
            or set(response) != {self.result_key}
            or not isinstance(response[self.result_key], str)
            or response[self.result_key] not in eligible
        ):
            return Decision(
                AlgorithmState(data={"rejected": "historical base not offered"}),
                (Operation("stop"),),
                "invalid diagnosis",
            )
        selected = response[self.result_key]
        return Decision(
            state,
            (
                Operation(
                    "generate_candidate",
                    candidate_id="new",
                    parent_id=selected,
                    task_ids=("seed",),
                    payload={
                        "meta": {
                            "prompt": "Improve the chosen base while preserving successful behavior.",
                            "schema": {"type": "string"},
                        }
                    },
                ),
            ),
            "use the diagnosed historical base",
        )


class ScreenBeforeEvaluation:
    def step(self, view, state):
        if not view.completed:
            return Decision(
                state,
                (
                    Operation(
                        "generate_candidate",
                        candidate_id="candidate",
                        parent_id="anchor",
                        task_ids=("seed",),
                    ),
                ),
                "propose",
            )
        result = view.completed[-1]
        if result.kind == "evaluate_seed":
            return Decision(state, (Operation("stop"),), "evaluation recorded")
        change = result.candidate_change
        reason = ""
        if not isinstance(change, dict) or change.get("omitted_patches", 1):
            reason = "candidate changes unavailable or incomplete"
        else:
            # Inspect additions, not deleted old content or model-supplied diff claims.
            additions = "\n".join(
                line[1:]
                for file in change["files"]
                for line in (file["patch"] or "").splitlines()
                if line.startswith("+") and not line.startswith("+++")
            )
            patterns = (
                r'AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*=\s*["\'][^"\']{8,}',
                r"\b(?:task|case|issue)[-_ ]?(?:id|name)\s*[:=]",
                r"\b(?:grader|verifier|judge|rubric)\b.*(?:read|detect|parse|match)",
            )
            if any(re.search(pattern, additions, re.I | re.S) for pattern in patterns):
                reason = "critic rejected candidate additions"
        if reason:
            return Decision(
                AlgorithmState(data={"rejected": reason}), (Operation("stop"),), reason
            )
        return Decision(
            state,
            (
                Operation(
                    "evaluate_seed",
                    candidate_id=result.candidate_id,
                    task_ids=("seed",),
                ),
            ),
            "critic accepted candidate",
        )


class SDKExample(HistoricalBase):
    """One-file author algorithm: evaluate, diagnose, generate, screen, evaluate, stop."""

    def step(self, view, state):
        if not view.evidence:
            return Decision(
                state,
                (
                    Operation(
                        "evaluate_seed", candidate_id="anchor", task_ids=("seed",)
                    ),
                ),
                "baseline",
            )
        if (
            view.completed
            and view.completed[-1].kind == "evaluate_seed"
            and view.completed[-1].candidate_id != "anchor"
        ):
            return Decision(state, (Operation("stop"),), "finished")
        meta = tuple(
            result
            for result in view.completed
            if result.kind in ("diagnose_seed", "generate_candidate")
        )
        view = replace(view, completed=meta)
        if not meta or meta[-1].kind == "diagnose_seed":
            return super().step(view, state)
        return ScreenBeforeEvaluation().step(view, state)
