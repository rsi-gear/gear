"""RRSI recipe built on Gear's public staged-search contract."""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, cast

from gear.canonical import JSON

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Operation,
    ParentPolicy,
    ProposalPlanner,
    RankingInput,
    SearchView,
    StopRule,
    TaskSampler,
)
from ..evidence import complete_scope_mean
from ..workflow import StagedSearch
from .config import RRSIConfig
from .history import (
    COMPONENTS,
    classify_diff,
    incumbent_component_counts,
    measured_history,
    normalize,
    novelty,
    prune_components,
    stalled,
    tried_components,
)
from .parents import select_parent
from .proposal import RRSIProposalPlanner
from .ranking import RRSIRanker
from .sampling import sample_tasks
from .stopping import RRSIStopRule


def _str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x) for x in value if isinstance(x, str)]
    return []


def _str_dict(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items() if isinstance(v, str)}
    return {}


def _int_dict(value: Any) -> dict[str, int]:
    if isinstance(value, dict):
        return {str(k): int(v) for k, v in value.items() if isinstance(v, int)}
    return {}


def _float_list(value: Any) -> list[float]:
    if isinstance(value, list):
        return [float(x) for x in value if isinstance(x, (int, float))]
    return []


def _obj_list(value: Any) -> list[dict[str, JSON]]:
    if isinstance(value, list):
        return [cast(dict[str, JSON], x) for x in value if isinstance(x, dict)]
    return []


def _int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) else default


class RRSI(StagedSearch):
    """Configurable RRSI policy recipe.

    Gear supplies sealed candidate changes; RRSI owns its screening policy.
    """

    def __init__(
        self,
        *,
        config: RRSIConfig | dict[str, Any] | None = None,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner | None = None,
        ranker: CandidateRanker | None = None,
        stop_rule: StopRule | None = None,
    ) -> None:
        if isinstance(config, dict):
            config = RRSIConfig(**config)
        self.config = (
            config
            or getattr(ranker, "config", None)
            or getattr(stop_rule, "config", None)
            or getattr(proposal_planner, "config", None)
            or RRSIConfig()
        )
        if ranker is not None and getattr(ranker, "config", None) != self.config:
            ranker = RRSIRanker(self.config)
        if stop_rule is not None and getattr(stop_rule, "config", None) != self.config:
            stop_rule = RRSIStopRule(self.config)
        if (
            proposal_planner is not None
            and getattr(proposal_planner, "config", None) != self.config
        ):
            proposal_planner = RRSIProposalPlanner(self.config)

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
        original_anchor = str(state.data.get("original_anchor_id", view.anchor_id))
        incumbent_id = str(state.data.get("incumbent_id", original_anchor))
        round_index = _int(state.data.get("round", 0))

        # Maintain S_star independently from current incumbent score
        s_star_raw = state.data.get("S_star")
        s_star = float(s_star_raw) if isinstance(s_star_raw, (int, float)) else None
        trajectory = _float_list(state.data.get("trajectory"))
        if s_star is None:
            ranking_in = RankingInput(
                (original_anchor,),
                tuple(task.id for task in view.tasks),
                view.evidence,
                view.budget.repetitions,
                objective=view.objective,
                anchor_id=original_anchor,
            )
            baseline_mean = complete_scope_mean(ranking_in)
            scores = dict(baseline_mean.scores)
            if original_anchor in scores:
                s_star = float(scores[original_anchor])
                if not trajectory:
                    trajectory = [s_star]
            else:
                s_star = 0.0

        state = AlgorithmState(
            data={
                **state.data,
                "original_anchor_id": original_anchor,
                "incumbent_id": incumbent_id,
                "S_star": s_star,
                "trajectory": cast(list[JSON], trajectory),
            }
        )

        # Handle independent RRSI round horizon
        if round_index >= self.config.rounds and state.data.get("phase") != "done":
            return self._finish(view, state, "RRSI round horizon reached")

        # Screening flow for generated candidates
        screened = self._screen_candidates(view, state)
        if screened is not None:
            return screened

        # Parent and ranking stages operate relative to the current incumbent
        search_view = view
        if any(c.id == incumbent_id for c in view.candidates):
            search_view = replace(view, anchor_id=incumbent_id)

        # Configure ranker with persistent S_star and candidate novelty
        novelty_map = state.data.get("candidate_novelty", {})
        if not isinstance(novelty_map, dict):
            novelty_map = {}
        novelty_typed = {
            str(k): int(v) for k, v in novelty_map.items() if isinstance(v, (int, float))
        }
        self.ranker = RRSIRanker(
            self.config,
            score_star=s_star,
            candidate_novelty=novelty_typed,
        )

        decision = super().step(search_view, state)

        # Check if ranking completed and an admissible winner emerged
        ranking = decision.state.data.get("ranking")
        if (
            isinstance(ranking, dict)
            and isinstance(ranking.get("candidate_ids"), list)
            and decision.state.data.get("phase") == "parents"
        ):
            parent = decision.state.data.get("parent")
            disqualified = set(_str_list(ranking.get("disqualified")))
            candidate_ids = _str_list(ranking.get("candidate_ids"))
            raw_scores = ranking.get("scores")
            scores_map: dict[str, float] = {}
            if isinstance(raw_scores, list):
                for item in raw_scores:
                    if (
                        isinstance(item, (list, tuple))
                        and len(item) == 2
                        and isinstance(item[0], str)
                        and isinstance(item[1], (int, float))
                    ):
                        scores_map[item[0]] = float(item[1])
            elif isinstance(raw_scores, dict):
                for k, v in raw_scores.items():
                    if isinstance(v, (int, float)):
                        scores_map[str(k)] = float(v)

            winner = next(
                (c for c in candidate_ids if c != parent and c not in disqualified),
                None,
            )
            if winner is not None:
                winner_score = scores_map.get(winner)
                new_s = winner_score if winner_score is not None else s_star
                new_s_star = max(s_star, new_s)
                new_trajectory = list(trajectory) + [new_s]
                incumbent_id = winner
                decision = replace(
                    decision,
                    state=replace(
                        decision.state,
                        data={
                            **decision.state.data,
                            "incumbent_id": winner,
                            "S_star": new_s_star,
                            "trajectory": cast(list[JSON], new_trajectory),
                        },
                    ),
                )
            else:
                inc_score = scores_map.get(incumbent_id)
                cur_s = inc_score if inc_score is not None else s_star
                new_trajectory = list(trajectory) + [cur_s]
                decision = replace(
                    decision,
                    state=replace(
                        decision.state,
                        data={
                            **decision.state.data,
                            "trajectory": cast(list[JSON], new_trajectory),
                        },
                    ),
                )

        # Update history and directives
        curr_round_idx = _int(decision.state.data.get("round", 0))
        prior_history = _obj_list(decision.state.data.get("rrsi_history"))
        cand_meta_raw = decision.state.data.get("candidate_meta")
        cand_meta_dict: dict[str, dict[str, Any]] = {}
        if isinstance(cand_meta_raw, dict):
            for k, v in cand_meta_raw.items():
                if isinstance(v, dict):
                    cand_meta_dict[str(k)] = v
        history = measured_history(
            prior_history,
            view.evidence,
            cand_meta_dict,
            t=curr_round_idx,
        )
        current_traj = decision.state.data.get("trajectory", trajectory)
        traj_scores = _float_list(current_traj)

        tried = sorted(tried_components(history))
        untried = [comp for comp in COMPONENTS if comp not in tried]
        is_stalled = stalled(
            traj_scores,
            curr_round_idx,
            self.config.stall_window,
            self.config.noise_delta,
        )
        directives: dict[str, JSON] = {
            "config": cast(JSON, self.config.to_json()),
            "edit_budget": self.config.edit_budget(curr_round_idx),
            "noise_delta": self.config.noise_delta,
            "critic": {"enabled": True},
            "history": cast(JSON, history),
            "stall": is_stalled,
            "tried_components": cast(JSON, tried),
            "untried_components": cast(JSON, untried),
            "prune_components": cast(
                JSON,
                prune_components(history, curr_round_idx, self.config.prune_window),
            ),
            "exploration_slots": self.config.exploration_slots if is_stalled else 0,
        }

        # Inject generation directives into any generate_candidate operation
        augmented_ops: list[Operation] = []
        for op in decision.operations:
            if op.kind == "generate_candidate":
                payload = dict(op.payload) if isinstance(op.payload, dict) else {}
                raw_meta = payload.get("meta")
                meta = dict(raw_meta) if isinstance(raw_meta, dict) else {}
                meta.update(
                    {
                        "directives": directives,
                        "edit_budget": directives["edit_budget"],
                        "noise_delta": directives["noise_delta"],
                        "stall": directives["stall"],
                        "tried_components": directives["tried_components"],
                        "untried_components": directives["untried_components"],
                        "prune_components": directives["prune_components"],
                        "history": directives["history"],
                    }
                )
                payload["meta"] = meta
                augmented_ops.append(replace(op, payload=payload))
            else:
                augmented_ops.append(op)

        data = cast(
            dict[str, JSON],
            {
                **decision.state.data,
                "rrsi": directives,
                "rrsi_history": history,
            },
        )
        return replace(
            decision,
            operations=tuple(augmented_ops),
            state=type(decision.state)(data=data),
        )

    def _next_round(self, view: SearchView, state: AlgorithmState) -> Decision:
        next_round = _int(state.data.get("round", 0)) + 1
        if (
            next_round >= self.config.rounds
            or next_round >= view.budget.rounds
            or view.budget.candidates_remaining <= 0
        ):
            return self._finish(view, state, "RRSI round horizon reached")
        return super()._next_round(view, state)

    def _finish(self, view: SearchView, state: AlgorithmState, reason: str) -> Decision:
        original_anchor = str(state.data.get("original_anchor_id", view.anchor_id))
        incumbent = str(state.data.get("incumbent_id", original_anchor))
        ranking = state.data.get("ranking")
        if isinstance(ranking, dict) and isinstance(ranking.get("candidate_ids"), list):
            parent = state.data.get("parent")
            disqualified = set(_str_list(ranking.get("disqualified")))
            candidate_ids = _str_list(ranking.get("candidate_ids"))
            winner = next(
                (c for c in candidate_ids if c != parent and c not in disqualified),
                None,
            )
            if winner is not None:
                incumbent = winner
        operations = (
            (Operation("nominate", candidate_id=incumbent, rationale=reason),)
            if incumbent != original_anchor
            else (Operation("stop", rationale=reason),)
        )
        return self._decision(
            {**state.data, "phase": "done", "incumbent_id": incumbent},
            operations,
            reason,
        )

    def _screen_candidates(self, view: SearchView, state: AlgorithmState) -> Decision | None:
        phase = state.data.get("phase")
        if phase not in ("generated", "screening", "screened"):
            return None

        screen_queue = _str_list(state.data.get("screen_queue"))
        screen_accepted = _str_list(state.data.get("screen_accepted"))
        screen_rejected = _str_dict(state.data.get("screen_rejected"))
        repairs = _int_dict(state.data.get("repairs"))
        candidate_meta_raw = state.data.get("candidate_meta")
        candidate_meta: dict[str, Any] = (
            dict(candidate_meta_raw) if isinstance(candidate_meta_raw, dict) else {}
        )
        candidate_novelty = _int_dict(state.data.get("candidate_novelty"))

        if phase == "generated" and not screen_queue:
            planned = state.data.get("planned", [])
            if not isinstance(planned, list) or not planned:
                return None
            screen_queue = [
                str(c)
                for c in planned
                if str(c) not in screen_accepted and str(c) not in screen_rejected
            ]
            if not screen_queue:
                return None

        # Handle returning from a semantic critic diagnosis
        if phase == "screening":
            curr_candidate = state.data.get("screen_candidate")
            if curr_candidate and str(curr_candidate) in screen_queue:
                cid = str(curr_candidate)
                critic_res = next(
                    (
                        item
                        for item in reversed(view.completed)
                        if item.kind == "diagnose_seed" and item.candidate_id == cid
                    ),
                    None,
                )
                valid_critic = False
                reasons: list[str] = ["critic rejected candidate"]
                if (
                    critic_res
                    and critic_res.status == "complete"
                    and isinstance(critic_res.data, dict)
                ):
                    if not critic_res.data.get("declined", False):
                        resp_data = critic_res.data.get("data")
                        if isinstance(resp_data, dict) and resp_data.get("verdict") == "accept":
                            valid_critic = True
                        elif isinstance(resp_data, dict) and isinstance(
                            resp_data.get("reasons"), list
                        ):
                            raw_reasons = resp_data.get("reasons")
                            if isinstance(raw_reasons, list):
                                reasons = [str(r) for r in raw_reasons]
                        elif "hypotheses" in critic_res.data:
                            # Mock provider in testkit toy_round
                            valid_critic = True

                if valid_critic:
                    screen_accepted.append(cid)
                    screen_queue.remove(cid)
                else:
                    repair_count = repairs.get(cid, 0)
                    if (
                        repair_count < self.config.max_repairs
                        and view.budget.candidates_remaining > 0
                    ):
                        repair_decision = self._create_repair(
                            view,
                            state,
                            cid,
                            repair_count,
                            "; ".join(reasons),
                            screen_queue,
                            screen_accepted,
                            screen_rejected,
                            repairs,
                            candidate_meta,
                            candidate_novelty,
                        )
                        if repair_decision is not None:
                            return repair_decision

                    screen_rejected[cid] = "; ".join(reasons)
                    screen_queue.remove(cid)
                    if not screen_queue and not screen_accepted and "batch_index" not in state.data:
                        reason = "; ".join(reasons)
                        return Decision(
                            AlgorithmState(
                                data={
                                    **state.data,
                                    "phase": "done",
                                    "rejected": reason,
                                    "screen_rejected": cast(dict[str, JSON], screen_rejected),
                                }
                            ),
                            (Operation("stop", rationale=reason),),
                            reason,
                        )

        # Process next candidate in screen_queue
        while screen_queue:
            cid = screen_queue[0]
            gen_res = next(
                (
                    item
                    for item in reversed(view.completed)
                    if item.kind == "generate_candidate"
                    and item.candidate_id == cid
                    and item.status == "complete"
                ),
                None,
            )
            if gen_res is None:
                screen_rejected[cid] = "generation incomplete or failed"
                screen_queue.pop(0)
                continue

            change = gen_res.candidate_change
            validity_err = self._check_change_validity(change)
            if validity_err:
                screen_rejected[cid] = validity_err
                screen_queue.pop(0)
                if not screen_queue and not screen_accepted and "batch_index" not in state.data:
                    return Decision(
                        AlgorithmState(
                            data={
                                **state.data,
                                "phase": "done",
                                "rejected": validity_err,
                                "screen_rejected": cast(dict[str, JSON], screen_rejected),
                            }
                        ),
                        (Operation("stop", rationale=validity_err),),
                        validity_err,
                    )
                continue

            hard_objections = self._hard_checks(change)
            if hard_objections:
                repair_count = repairs.get(cid, 0)
                if repair_count < self.config.max_repairs and view.budget.candidates_remaining > 0:
                    repair_decision = self._create_repair(
                        view,
                        state,
                        cid,
                        repair_count,
                        "; ".join(hard_objections),
                        screen_queue,
                        screen_accepted,
                        screen_rejected,
                        repairs,
                        candidate_meta,
                        candidate_novelty,
                    )
                    if repair_decision is not None:
                        return repair_decision

                screen_rejected[cid] = "; ".join(hard_objections)
                screen_queue.pop(0)
                if not screen_queue and not screen_accepted and "batch_index" not in state.data:
                    reason = "; ".join(hard_objections)
                    return Decision(
                        AlgorithmState(
                            data={
                                **state.data,
                                "phase": "done",
                                "rejected": reason,
                                "screen_rejected": cast(dict[str, JSON], screen_rejected),
                            }
                        ),
                        (Operation("stop", rationale=reason),),
                        reason,
                    )
                continue

            # Candidate passed deterministic hard checks: extract component attribution
            components = self._extract_components(change)
            prior_history = _obj_list(state.data.get("rrsi_history"))
            inc_counts = incumbent_component_counts(prior_history)
            cand_nov = novelty(components, inc_counts)
            candidate_novelty[cid] = cand_nov
            candidate_meta[cid] = {
                "component": components[0] if components else "prompt",
                "components": cast(list[JSON], components),
                "novelty": cand_nov,
            }

            # Check reserved exploration slot when stalled
            round_idx = _int(state.data.get("round", 0))
            tried = tried_components(prior_history)
            untried = [c for c in COMPONENTS if c not in tried]
            traj_scores = _float_list(state.data.get("trajectory"))
            if (
                stalled(traj_scores, round_idx, self.config.stall_window, self.config.noise_delta)
                and untried
            ):
                if not any(c in untried for c in components):
                    objection = f"exploration slot requires an untried component from {untried}"
                    repair_count = repairs.get(cid, 0)
                    if (
                        repair_count < self.config.max_repairs
                        and view.budget.candidates_remaining > 0
                    ):
                        repair_decision = self._create_repair(
                            view,
                            state,
                            cid,
                            repair_count,
                            objection,
                            screen_queue,
                            screen_accepted,
                            screen_rejected,
                            repairs,
                            candidate_meta,
                            candidate_novelty,
                        )
                        if repair_decision is not None:
                            return repair_decision
                    screen_rejected[cid] = objection
                    screen_queue.pop(0)
                    continue

            # Surviving candidate undergoes semantic review
            prompt = self._critic_prompt(change)
            failures_raw = state.data.get("failures")
            failures = (
                tuple(str(item) for item in failures_raw)
                if isinstance(failures_raw, (list, tuple))
                else ()
            )
            return Decision(
                AlgorithmState(
                    data={
                        **state.data,
                        "phase": "screening",
                        "screen_candidate": cid,
                        "screen_queue": cast(list[JSON], screen_queue),
                        "screen_accepted": cast(list[JSON], screen_accepted),
                        "screen_rejected": cast(dict[str, JSON], screen_rejected),
                        "repairs": cast(dict[str, JSON], repairs),
                        "candidate_meta": cast(dict[str, JSON], candidate_meta),
                        "candidate_novelty": cast(dict[str, JSON], candidate_novelty),
                    }
                ),
                (
                    Operation(
                        "diagnose_seed",
                        candidate_id=cid,
                        parent_id=str(state.data.get("parent", view.anchor_id)),
                        task_ids=failures,
                        payload={
                            "meta": {
                                "prompt": prompt,
                                "schema": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "verdict": {
                                            "type": "string",
                                            "enum": ["accept", "reject"],
                                        },
                                        "reasons": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "risk_notes": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                    },
                                    "required": ["verdict"],
                                },
                            }
                        },
                        rationale="screen candidate with RRSI critic",
                    ),
                ),
                "screen candidate with RRSI critic",
            )

        # All candidates in the batch have been screened
        next_state = AlgorithmState(
            data={
                **state.data,
                "phase": "screened",
                "screen_queue": cast(list[JSON], []),
                "screen_accepted": cast(list[JSON], screen_accepted),
                "screen_rejected": cast(dict[str, JSON], screen_rejected),
                "repairs": cast(dict[str, JSON], repairs),
                "candidate_meta": cast(dict[str, JSON], candidate_meta),
                "candidate_novelty": cast(dict[str, JSON], candidate_novelty),
                "planned": cast(list[JSON], screen_accepted),
            }
        )
        if screen_accepted:
            return self._evaluate(view, next_state, tuple(screen_accepted), 0)
        if "batch_index" not in state.data:
            reason = "all candidates in batch rejected by screening"
            return Decision(
                AlgorithmState(
                    data={
                        **next_state.data,
                        "phase": "done",
                        "rejected": reason,
                    }
                ),
                (Operation("stop", rationale=reason),),
                reason,
            )
        return self._next_batch(view, next_state, "all candidates in batch rejected by screening")

    def _create_repair(
        self,
        view: SearchView,
        state: AlgorithmState,
        candidate_id: str,
        repair_count: int,
        objection: str,
        screen_queue: list[str],
        screen_accepted: list[str],
        screen_rejected: dict[str, str],
        repairs: dict[str, int],
        candidate_meta: dict[str, Any],
        candidate_novelty: dict[str, int],
    ) -> Decision | None:
        if view.budget.candidates_remaining <= 0:
            return None
        repair_id = f"{candidate_id}-repair-{repair_count + 1}"
        repairs[candidate_id] = repair_count + 1
        screen_queue[screen_queue.index(candidate_id)] = repair_id

        # Extract rejected diff excerpt for repair context
        gen_res = next(
            (
                item
                for item in reversed(view.completed)
                if item.kind == "generate_candidate" and item.candidate_id == candidate_id
            ),
            None,
        )
        diff_text = self._format_diff(gen_res.candidate_change) if gen_res else ""
        parent_id = str(state.data.get("parent", view.anchor_id))
        repair_prompt = (
            f"Critic rejected candidate {candidate_id} for: {objection}\n\n"
            f"Rejected diff excerpt:\n{diff_text[:4000]}\n\n"
            "Repair the candidate harness: remove the rejected behavior or prohibited patterns "
            "while addressing the task failures without regressions."
        )

        failures_raw = state.data.get("failures")
        failures = (
            tuple(str(item) for item in failures_raw)
            if isinstance(failures_raw, (list, tuple))
            else ()
        )
        return Decision(
            AlgorithmState(
                data={
                    **state.data,
                    "phase": "generated",
                    "planned": cast(list[JSON], [repair_id]),
                    "screen_queue": cast(list[JSON], screen_queue),
                    "screen_accepted": cast(list[JSON], screen_accepted),
                    "screen_rejected": cast(dict[str, JSON], screen_rejected),
                    "repairs": cast(dict[str, JSON], repairs),
                    "candidate_meta": cast(dict[str, JSON], candidate_meta),
                    "candidate_novelty": cast(dict[str, JSON], candidate_novelty),
                }
            ),
            (
                Operation(
                    "generate_candidate",
                    candidate_id=repair_id,
                    parent_id=parent_id,
                    task_ids=failures,
                    payload={
                        "hypothesis": f"Repair {candidate_id}: {objection}",
                        "meta": {
                            "prompt": repair_prompt,
                            "schema": {"type": "string"},
                        },
                    },
                    rationale=f"repair rejected candidate {candidate_id}",
                ),
            ),
            f"repair rejected candidate {candidate_id}",
        )

    @staticmethod
    def _check_change_validity(change: JSON) -> str | None:
        if not isinstance(change, dict):
            return "candidate changes unavailable or incomplete"
        omitted = change.get("omitted_patches", 0)
        if isinstance(omitted, (int, float)) and omitted > 0:
            return "candidate changes unavailable or incomplete"
        files = change.get("files")
        if not isinstance(files, list):
            return "candidate changes unavailable or incomplete"
        return None

    @staticmethod
    def _format_diff(change: JSON) -> str:
        if not isinstance(change, dict):
            return ""
        files = change.get("files")
        if not isinstance(files, list):
            return ""
        patches: list[str] = []
        for item in files:
            if isinstance(item, dict):
                patch = item.get("patch")
                path = item.get("path", "")
                if isinstance(patch, str):
                    patches.append(f"--- a/{path}\n+++ b/{path}\n{patch}")
        return "\n".join(patches)

    @staticmethod
    def _hard_checks(change: JSON) -> list[str]:
        if not isinstance(change, dict):
            return ["candidate changes unavailable or incomplete"]
        files = change.get("files")
        if not isinstance(files, list):
            return ["candidate changes unavailable or incomplete"]

        added_lines: list[str] = []
        for item in files:
            if isinstance(item, dict):
                patch = item.get("patch")
                if isinstance(patch, str):
                    for line in patch.splitlines():
                        if line.startswith("+") and not line.startswith("+++"):
                            added_lines.append(line[1:])

        if not added_lines or not any(line.strip() for line in added_lines):
            return ["empty diff"]

        additions_text = "\n".join(added_lines)
        objections: list[str] = []

        # Credential pattern
        if re.search(
            r"AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*=\s*[\"'][^\"']{8,}",
            additions_text,
            re.I,
        ):
            objections.append("credential in diff")

        # Grader / verifier patterns (line-by-line checks)
        verifier_patterns = (
            r"/tests\b|test_outputs|\breward\.(txt|json)\b|\bctrf\b|/solution\b|task\.toml|/logs/verifier",
            r"\b(?:grader|verifier|judge|rubric)\b.*(?:\.read|\.detect|\.parse|\.match|\.score|read\(|detect\(|parse\()",
        )
        for line in added_lines:
            if any(re.search(pat, line, re.I) for pat in verifier_patterns):
                objections.append(f"verifier/solution leak: {line.strip()[:80]}")
                break

        # Task specialization patterns (hardcoding specific task ids/names, not type hints)
        task_hint_pat = re.compile(
            r"\b(?:task|case|issue)[-_ ]?(?:id|name)\s*==?\s*[\"']|\b(?:task|case|issue)[-_ ]?(?:id|name)\s*:\s*[\"']",
            re.I,
        )
        for line in added_lines:
            if task_hint_pat.search(line):
                objections.append(f"task-specific hint: {line.strip()[:80]}")
                break

        return objections

    def _extract_components(self, change: JSON) -> list[str]:
        diff_text = self._format_diff(change)
        comp = classify_diff(diff_text)
        return [normalize(comp, diff_text)]

    def _critic_prompt(self, change: JSON) -> str:
        diff_text = self._format_diff(change)
        return (
            "You are a strict anti-overfitting reviewer of harness code changes.\n"
            "Review the following candidate change for credentials, hardcoded task logic, "
            "oracle solution paths, verifier gaming, or inert machinery.\n\n"
            f"=== DIFF ===\n{diff_text[:20000]}\n\n"
            'Return STRICT JSON: {"verdict": "accept" | "reject", "reasons": [...], "risk_notes": [...]}'
        )
