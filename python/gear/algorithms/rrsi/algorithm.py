"""RRSI recipe built on Gear's public staged-search contract."""

from __future__ import annotations

import re
from dataclasses import replace
from typing import cast

from gear.canonical import JSON

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Operation,
    ParentPolicy,
    ProposalPlanner,
    SearchView,
    StopRule,
    TaskSampler,
)
from ..workflow import StagedSearch
from .config import RRSIConfig
from .history import COMPONENTS, measured_history, prune_components, stalled, tried_components
from .parents import select_parent
from .proposal import RRSIProposalPlanner
from .ranking import RRSIRanker
from .sampling import sample_tasks
from .stopping import RRSIStopRule


class RRSI(StagedSearch):
    """Configurable RRSI policy recipe.

    Gear supplies sealed candidate changes; RRSI owns its screening policy.
    """

    def __init__(
        self,
        *,
        config: RRSIConfig | None = None,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner | None = None,
        ranker: CandidateRanker | None = None,
        stop_rule: StopRule | None = None,
    ) -> None:
        if isinstance(config, dict):
            config = RRSIConfig(**config)
        self.config = config or RRSIConfig()
        planner = proposal_planner or RRSIProposalPlanner(self.config)
        ranking = ranker or RRSIRanker(self.config)
        stopping = stop_rule or RRSIStopRule(self.config)
        super().__init__(
            parent_policy,
            sampler,
            planner,
            ranking,
            stopping,
            ("global",),
            (),
        )

    @property
    def configuration(self) -> dict[str, JSON]:
        return {"config": cast(JSON, self.config.to_json())}

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        screened = self._screen_generated(view, state)
        if screened is not None:
            return screened
        if state.data.get("phase") == "screening":
            return self._finish_screening(view, state)
        incumbent_id = state.data.get("incumbent_id")
        if isinstance(incumbent_id, str) and any(
            candidate.id == incumbent_id for candidate in view.candidates
        ):
            view = replace(view, anchor_id=incumbent_id)
        decision = super().step(view, state)
        ranking = decision.state.data.get("ranking")
        if (
            isinstance(ranking, dict)
            and decision.state.data.get("phase") == "parents"
            and isinstance(ranking.get("candidate_ids"), list)
        ):
            parent = decision.state.data.get("parent")
            winner = next(
                (
                    candidate
                    for candidate in ranking["candidate_ids"]
                    if isinstance(candidate, str)
                    and candidate != parent
                    and candidate not in ranking.get("disqualified", [])
                ),
                None,
            )
            if winner is not None:
                decision = replace(
                    decision,
                    state=replace(
                        decision.state,
                        data={**decision.state.data, "incumbent_id": winner},
                    ),
                )
        round_value = decision.state.data.get("round", 0)
        round_index = round_value if type(round_value) is int else 0
        prior_raw = decision.state.data.get("rrsi_history", [])
        prior_history: list[dict[str, JSON]] = (
            cast(list[dict[str, JSON]], [item for item in prior_raw if isinstance(item, dict)])
            if isinstance(prior_raw, list)
            else []
        )
        history = measured_history(prior_history, view.evidence)
        score_trajectory: list[float] = []
        for row in history:
            score = row.get("score")
            if isinstance(score, (int, float)):
                score_trajectory.append(float(score))
        tried = sorted(tried_components(history))
        untried = [component for component in COMPONENTS if component not in tried]
        directives: dict[str, JSON] = {
            "config": cast(JSON, self.config.to_json()),
            "edit_budget": self.config.edit_budget(round_index),
            "noise_delta": self.config.noise_delta,
            "critic": {"enabled": True},
            "history": cast(JSON, history),
            "stall": stalled(
                score_trajectory,
                round_index,
                self.config.stall_window,
                self.config.noise_delta,
            ),
            "tried_components": cast(JSON, tried),
            "untried_components": cast(JSON, untried),
            "prune_components": cast(JSON, prune_components(history)),
        }
        data = cast(
            dict[str, JSON],
            {**decision.state.data, "rrsi": directives, "rrsi_history": history},
        )
        return replace(decision, state=type(decision.state)(data=data))

    def _screen_generated(self, view: SearchView, state: AlgorithmState) -> Decision | None:
        if state.data.get("phase") != "generated":
            return None
        planned = state.data.get("planned")
        if not isinstance(planned, list) or not planned:
            return None
        candidate_id = planned[-1]
        result = next(
            (
                item
                for item in reversed(view.completed)
                if item.kind == "generate_candidate"
                and item.candidate_id == candidate_id
                and item.status == "complete"
            ),
            None,
        )
        if result is None:
            return None
        reason = self._screen_reason(result.candidate_change)
        if reason is None:
            return None
        if reason != "candidate changes unavailable or incomplete":
            return Decision(
                AlgorithmState(
                    data={
                        **state.data,
                        "phase": "screening",
                        "screen_candidate": candidate_id,
                        "screen_reason": reason,
                    }
                ),
                (
                    Operation(
                        "diagnose_seed",
                        candidate_id=candidate_id,
                        parent_id=str(state.data["parent"]),
                        task_ids=tuple(str(item) for item in state.data["failures"]),
                        payload={
                            "meta": {
                                "prompt": (
                                    "Review the candidate change for credentials, task-specific "
                                    "logic, or grader-directed behavior. Return a verdict."
                                ),
                                "schema": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "verdict": {
                                            "type": "string",
                                            "enum": ["accept", "reject"],
                                        },
                                        "reason": {"type": "string"},
                                    },
                                    "required": ["verdict", "reason"],
                                },
                            }
                        },
                    ),
                ),
                "screen candidate with RRSI critic",
            )
        return Decision(
            AlgorithmState(
                data={
                    **state.data,
                    "phase": "done",
                    "rejected": reason,
                }
            ),
            (Operation("stop", rationale=reason),),
            reason,
        )

    def _finish_screening(self, view: SearchView, state: AlgorithmState) -> Decision:
        result = next(
            (
                item
                for item in reversed(view.completed)
                if item.kind == "diagnose_seed"
                and item.candidate_id == state.data.get("screen_candidate")
            ),
            None,
        )
        response = result.data.get("data") if result and isinstance(result.data, dict) else None
        accepted = isinstance(response, dict) and response.get("verdict") == "accept"
        if accepted:
            state = AlgorithmState(
                data={
                    **state.data,
                    "phase": "screened",
                    "planned": [state.data["screen_candidate"]],
                }
            )
            return self._evaluate(view, state, (str(state.data["screen_candidate"]),), 0)
        repairs = state.data.get("repairs", 0)
        repairs_count = repairs if type(repairs) is int else 0
        if repairs_count < self.config.max_repairs:
            candidate_id = f"{state.data['screen_candidate']}-repair-{repairs_count + 1}"
            return Decision(
                AlgorithmState(
                    data={
                        **state.data,
                        "phase": "generated",
                        "planned": [candidate_id],
                        "repairs": repairs_count + 1,
                    }
                ),
                (
                    Operation(
                        "generate_candidate",
                        candidate_id=candidate_id,
                        parent_id=str(state.data["parent"]),
                        task_ids=tuple(str(item) for item in state.data["failures"]),
                        payload={
                            "meta": {
                                "prompt": "Repair the candidate while removing the rejected behavior.",
                                "schema": {"type": "string"},
                            }
                        },
                    ),
                ),
                "repair rejected candidate",
            )
        reason = "critic rejected candidate"
        return Decision(
            AlgorithmState(data={**state.data, "phase": "done", "rejected": reason}),
            (Operation("stop", rationale=reason),),
            reason,
        )

    @staticmethod
    def _screen_reason(change: JSON) -> str | None:
        if not isinstance(change, dict) or change.get("omitted_patches", 1):
            return "candidate changes unavailable or incomplete"
        files = change.get("files")
        if not isinstance(files, list):
            return "candidate changes unavailable or incomplete"
        additions = "\n".join(
            line[1:]
            for item in files
            if isinstance(item, dict) and isinstance(item.get("patch"), str)
            for line in item["patch"].splitlines()
            if line.startswith("+") and not line.startswith("+++")
        )
        patterns = (
            r"AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*=\s*[\"'][^\"']{8,}",
            r"\b(?:task|case|issue)[-_ ]?(?:id|name)\s*[:=]",
            r"\b(?:grader|verifier|judge|rubric)\b.*(?:read|detect|parse|match)",
        )
        return (
            "critic rejected candidate additions"
            if any(re.search(pattern, additions, re.I | re.S) for pattern in patterns)
            else None
        )
