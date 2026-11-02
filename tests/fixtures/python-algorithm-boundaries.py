"""Acceptance cases distilled from PR #95 (f0e7339) and #99 (e7ce69d).

Only the algorithm/runtime boundary is exercised, not full paper reproduction.
Screening is an algorithm decision; it never manufactures evaluation evidence.
"""

import re

from gear.algorithms import AlgorithmState, Decision, Operation


class HistoricalBase:
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
                        payload={"base_candidates": bases},
                    ),
                ),
                "compare historical bases",
            )
        selected = view.completed[-1].data["base_candidate_id"]
        assert selected in {candidate.id for candidate in view.candidates}
        return Decision(
            state,
            (
                Operation(
                    "generate_candidate",
                    candidate_id="new",
                    parent_id=selected,
                    task_ids=("seed",),
                    payload={"hypothesis": "improve the chosen base"},
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
