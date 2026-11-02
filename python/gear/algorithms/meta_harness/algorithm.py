"""Meta-Harness Terminal-Bench 2 adaptation using Gear's public algorithm API."""

from dataclasses import asdict
import json
from typing import cast

from gear.canonical import JSON

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Evidence,
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
from ..workflow import StagedSearch, integer, objects
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
            return self._finish(view, state, "Meta-Harness candidate or generation budget exhausted")

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
        base_candidates: list[dict[str, JSON]] = []
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
            base_candidates.append(
                {
                    "candidate_id": candidate_id,
                    "score": score,
                    "task_scores": dict(profile),
                }
            )

        parent_input = ParentInput(tuple(eligible), 1, view.anchor_id)
        parent_plan = self.parent_policy(parent_input, self._rng(view))
        validate_parent_plan(parent_input, parent_plan)
        if not parent_plan.allocations:
            return self._finish(view, state, parent_plan.reason)
        selection = parent_plan.allocations[0].selection
        diagnosis_candidate = selection.option.candidate_id
        research = ResearchRecord(
            "parents",
            "global",
            task_ids,
            tuple(item.candidate_id for item in eligible),
            {
                "round": integer(state.data.get("round", 0)),
                "selection": "Meta-Harness diagnosis candidate",
                "plan": json.loads(json.dumps(asdict(parent_plan))),
                "eligible_base_candidates": [item["candidate_id"] for item in base_candidates],
            },
        )
        next_state = AlgorithmState(
            data={
                **state.data,
                "phase": "proposals",
                "round": integer(state.data.get("round", 0)),
                "diagnosis_candidate": diagnosis_candidate,
                "base_candidates": cast(JSON, base_candidates),
                "parent_reason": parent_plan.reason,
            }
        )
        operation = Operation(
            "diagnose_seed",
            candidate_id=diagnosis_candidate,
            task_ids=task_ids,
            rationale=HISTORY_GUIDANCE,
            payload={
                "base_candidates": cast(JSON, base_candidates),
                "meta": diagnosis_meta(base_candidates),
            },
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

        offered = objects(state.data.get("base_candidates", []))
        eligible_ids = tuple(
            str(item["candidate_id"])
            for item in offered
            if isinstance(item.get("candidate_id"), str)
        )
        diagnosis = parse_diagnosis(results[-1].data, eligible_ids)
        if diagnosis is None:
            return self._next_batch(view, state, "Meta-Harness proposer declined")

        failures = tuple(
            cell
            for cell in view.evidence
            if cell.candidate_id == diagnosis_candidate
            and cell.score is not None
            and (cell.score < 1 or view.objective is not None)
        )
        parent = ParentOption(diagnosis_candidate, "global", self._all_tasks(view), 0.0)
        plan = self.proposal_planner(
            ProposalInput(parent, failures, diagnosis, 1, view.tasks)
        )
        if (
            not plan.reason
            or len(plan.hypotheses) != 1
            or not plan.hypotheses[0].strip()
            or set(plan.task_ids) - set(self._all_tasks(view))
        ):
            raise ValueError("Meta-Harness must propose exactly one in-scope candidate")
        selected_base = cast(str, diagnosis["base_candidate_id"])
        # This check is algorithm-side. The proposer cannot select a partial or
        # held-out candidate even if it ignores the schema supplied by the worker.
        if selected_base not in eligible_ids:
            raise ValueError("Meta-Harness selected a base outside the seed-evaluated archive")

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
