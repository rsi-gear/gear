"""Meta-Harness Terminal-Bench 2 adaptation using Gear's public algorithm API."""

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Operation,
    ParentInput,
    ParentOption,
    ParentPolicy,
    ProposalInput,
    ProposalPlanner,
    RankingInput,
    ResearchRecord,
    SearchView,
    StopRule,
    TaskSampler,
)
from ..evidence import task_scores
from ..validation import validate_parent_plan
from ..workflow import StagedSearch, integer
from .parents import select_frontier_parent
from .proposal import (
    HISTORY_GUIDANCE,
    diagnosis_meta,
    generation_meta,
    parse_diagnosis,
    plan_proposals,
)
from .ranking import rank_candidates
from .sampling import sample_all_tasks
from .stopping import stop_reason


class MetaHarness(StagedSearch):
    """Run one full-seed candidate iteration, with base choice owned by the proposer."""

    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_frontier_parent,
        sampler: TaskSampler = sample_all_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule = stop_reason,
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("global",),
            (),
        )

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        if state.version != 1:
            raise ValueError("unsupported Meta-Harness state version")
        reason = self.stop_rule(view, state)
        if reason:
            return Decision(state, (Operation("stop", rationale=reason),), reason)
        phase = state.data.get("phase", "baseline")
        if phase == "parents":
            return self._diagnose_history(view, state)
        if phase == "proposals":
            return self._propose_from_history(view, state)
        # Gear's shared workflow still owns baseline/global evaluations, ranking,
        # budgets, nomination and the held-out promotion gate.
        return super().step(view, state)

    def _diagnose_history(self, view: SearchView, state: AlgorithmState) -> Decision:
        if (
            view.budget.candidates_remaining <= 0
            or view.budget.generation_batch_capacity == 0
            or integer(state.data.get("round", 0)) >= view.budget.rounds
        ):
            return self._finish(
                view, state, "Meta-Harness candidate or generation budget exhausted"
            )

        task_ids = self._all_tasks(view)
        if not task_ids:
            return self._finish(view, state, "no seed tasks are available")
        task_weights = tuple((task_id, 1 / len(task_ids)) for task_id in task_ids)
        ranking_input = RankingInput(
            tuple(candidate.id for candidate in view.candidates),
            task_ids,
            view.evidence,
            view.budget.repetitions,
            task_weights,
            objective=view.objective,
            anchor_id=view.anchor_id,
        )
        ranking = self.ranker(ranking_input)
        profiles = task_scores(ranking_input)
        snapshots = {candidate.id: candidate for candidate in view.candidates}
        eligible: list[ParentOption] = []
        for candidate_id, score in ranking.scores:
            profile = profiles.get(candidate_id)
            if profile is None:
                continue
            if candidate_id in ranking.disqualified and candidate_id != view.anchor_id:
                continue
            snapshot = snapshots.get(candidate_id)
            if snapshot is None:
                raise ValueError("ranker returned an unknown Meta-Harness candidate")
            eligible.append(
                ParentOption(
                    candidate_id,
                    "global",
                    task_ids,
                    score,
                    task_scores=profile,
                    weights=task_weights,
                    content_digest=snapshot.digest,
                )
            )

        if not eligible:
            return self._finish(view, state, "no candidate has complete comparable seed evidence")
        parent_input = ParentInput(tuple(eligible), 1, view.anchor_id)
        parent_plan = self.parent_policy(parent_input, self._rng(view))
        validate_parent_plan(parent_input, parent_plan)
        # A policy may prioritize candidates, but the proposer gets every eligible
        # complete seed candidate and makes the reference's history-driven base choice.
        prioritized = [
            allocation.selection.option.candidate_id
            for allocation in parent_plan.allocations
            if allocation.selection.option.candidate_id in {item.candidate_id for item in eligible}
        ]
        by_id = {item.candidate_id: item for item in eligible}
        offered = [by_id[candidate_id] for candidate_id in dict.fromkeys(prioritized)]
        offered.extend(item for item in eligible if item.candidate_id not in prioritized)
        diagnosis_candidate = view.anchor_id
        if diagnosis_candidate not in snapshots:
            raise ValueError("Meta-Harness anchor is absent from the candidate snapshot")
        base_candidates = [
            {
                "candidate_id": item.candidate_id,
                "score": item.score,
                "task_scores": dict(item.task_scores),
                "content_digest": item.content_digest,
            }
            for item in offered
        ]
        research = ResearchRecord(
            "parents",
            "global",
            task_ids,
            tuple(item.candidate_id for item in eligible),
            {
                "round": integer(state.data.get("round", 0)),
                "selection": "Meta-Harness eligible bases offered to proposer",
                "prioritized_by_policy": prioritized,
                "eligible_base_candidates": [item.candidate_id for item in offered],
            },
        )
        next_state = AlgorithmState(
            data={
                **state.data,
                "phase": "proposals",
                "round": integer(state.data.get("round", 0)),
                "diagnosis_candidate": diagnosis_candidate,
                "offered_base_candidates": base_candidates,
            }
        )
        operation = Operation(
            "diagnose_seed",
            candidate_id=diagnosis_candidate,
            task_ids=task_ids,
            rationale=HISTORY_GUIDANCE,
            payload={"base_candidates": base_candidates, "meta": diagnosis_meta(base_candidates)},
        )
        return self._decision(
            next_state.data,
            (operation,),
            "diagnose the full seed archive",
            (research,),
        )

    def _propose_from_history(self, view: SearchView, state: AlgorithmState) -> Decision:
        diagnosis_candidate = str(state.data.get("diagnosis_candidate", ""))
        results = [
            result
            for result in view.completed
            if result.kind == "diagnose_seed" and result.candidate_id == diagnosis_candidate
        ]
        if not results or results[-1].status != "complete":
            return self._next_batch(view, state, "Meta-Harness diagnosis did not complete")

        offered = state.data.get("offered_base_candidates")
        if not isinstance(offered, list):
            raise ValueError("Meta-Harness state lost its offered base candidates")
        eligible_ids = tuple(
            item["candidate_id"]
            for item in offered
            if isinstance(item, dict) and isinstance(item.get("candidate_id"), str)
        )
        diagnosis = parse_diagnosis(results[-1].data, eligible_ids)
        if diagnosis is None:
            return self._next_batch(view, state, "Meta-Harness proposer declined")

        selected_base = str(diagnosis["base_candidate_id"])
        base_snapshot = next((item for item in view.candidates if item.id == selected_base), None)
        if base_snapshot is None or selected_base not in eligible_ids:
            raise ValueError("Meta-Harness selected a base outside the complete seed archive")
        failures = tuple(
            cell
            for cell in view.evidence
            if cell.candidate_id == selected_base
            and cell.score is not None
            and cell.score < 1
        )
        parent = ParentOption(selected_base, "global", self._all_tasks(view), 0.0)
        plan = self.proposal_planner(ProposalInput(parent, failures, diagnosis, 1, view.tasks))
        if (
            not plan.reason
            or len(plan.hypotheses) != 1
            or not plan.hypotheses[0].strip()
            or set(plan.task_ids) - set(self._all_tasks(view))
        ):
            raise ValueError("Meta-Harness must propose exactly one in-scope candidate")
        candidate_id = f"r{integer(state.data.get('round', 0))}-candidate-0"
        operation = Operation(
            "generate_candidate",
            candidate_id=candidate_id,
            parent_id=selected_base,
            task_ids=plan.task_ids,
            rationale=plan.reason,
            payload={
                "hypothesis": plan.hypotheses[0],
                "meta": generation_meta(plan.hypotheses[0]),
            },
        )
        return self._decision(
            {
                **state.data,
                "phase": "generated",
                "planned": [candidate_id],
                "parent": selected_base,
                "failures": list(plan.task_ids),
                "limit": 1,
                "stage_index": 0,
            },
            (operation,),
            plan.reason,
            (
                ResearchRecord(
                    "parents",
                    "global",
                    self._all_tasks(view),
                    (selected_base,),
                    {
                        "round": integer(state.data.get("round", 0)),
                        "selection": "Meta-Harness proposer",
                        "diagnosis_candidate": diagnosis_candidate,
                        "offered_base_candidates": list(eligible_ids),
                        "selected_base_candidate": selected_base,
                    },
                ),
            ),
        )

    def _next_batch(self, view: SearchView, state: AlgorithmState, reason: str) -> Decision:
        next_round = integer(state.data.get("round", 0)) + 1
        next_state = AlgorithmState(data={"phase": "parents", "round": next_round})
        if (
            next_round < view.budget.rounds
            and view.budget.candidates_remaining > 0
            and view.budget.generation_batch_capacity != 0
        ):
            return self._diagnose_history(view, next_state)
        return self._finish(view, next_state, reason)
