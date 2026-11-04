"""Author recipes adapt native plans to core-owned generation capacity."""

import json
import unittest
from dataclasses import asdict, replace

from staged_search_fixture import advance, decision_after_baseline

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    ParentAllocation,
    ParentPlan,
    ProposalPlan,
    RandomSearch,
    SearchView,
    Task,
)
from gear.canonical import digest


class GenerationBudgetTests(unittest.TestCase):
    def view(self, capacity):
        return SearchView(
            "generation-budget", 1, "fixed", (Task("a", "family"),),
            (Candidate("anchor", digest("anchor")),),
            (Evidence("anchor", "a", 0, 0, "valid", "global"),), (),
            Budget(20, 3, 1, generation_requests_remaining=capacity,
                   generation_tokens_remaining=capacity, generation_batch_capacity=capacity),
            "anchor",
        )

    def until(self, algorithm, view, predicate):
        state = AlgorithmState()
        for _ in range(40):
            decision = algorithm.step(view, state)
            if predicate(decision):
                return view, decision
            self.assertNotIn(decision.operations[0].kind, ("stop", "nominate"))
            view = advance(view, decision.operations)
            state = decision.state
        self.fail("search did not reach the requested native checkpoint")

    def test_exhaustion_stops_before_another_diagnosis_or_generation(self):
        for recipe in (GEPA, RandomSearch):
            with self.subTest(recipe=recipe.__name__, phase="parents"):
                decision = decision_after_baseline(recipe(), self.view(0))
                self.assertEqual(decision.operations[0].kind, "stop")
                self.assertIn("generation budget exhausted", decision.reason)
            with self.subTest(recipe=recipe.__name__, phase="proposals"):
                algorithm = recipe()
                view, diagnosis = self.until(
                    algorithm, self.view(3),
                    lambda decision: decision.operations[0].kind == "diagnose_seed",
                )
                self.assertEqual(diagnosis.state.data["policy_state"]["phase"], "proposals")
                view = advance(view, diagnosis.operations)
                view = replace(view, budget=replace(
                    view.budget, generation_requests_remaining=0,
                    generation_tokens_remaining=0, generation_batch_capacity=0,
                ))
                decision = recipe().step(view, diagnosis.state)
                self.assertEqual(decision.operations[0].kind, "stop")
                self.assertIn("generation budget exhausted", decision.reason)

    def test_proposal_count_is_bounded_by_affordable_batch_capacity(self):
        for recipe in (GEPA, RandomSearch):
            with self.subTest(recipe=recipe.__name__):
                view, diagnosis = self.until(
                    recipe(), self.view(1),
                    lambda decision: decision.operations[0].kind == "diagnose_seed",
                )
                view = advance(view, diagnosis.operations, diagnosis={
                    "hypotheses": ["one", "two", "three"],
                })
                decision = recipe().step(view, diagnosis.state)
                self.assertEqual(len(decision.operations), 1)
                self.assertEqual(decision.operations[0].kind, "generate_candidate")

    def test_planner_receives_selected_parent_after_json_resume_and_batch_advance(self):
        for recipe in (GEPA, RandomSearch):
            with self.subTest(recipe=recipe.__name__):
                selected, received = [], []

                def parents(parent_input, rng):
                    # The first real round admits a candidate and, for GEPA, a local scope.
                    if parent_input.candidate_limit == 1:
                        option = next(item for item in parent_input.eligible if item.scope == "global")
                        return ParentPlan.single(rng.choice((option,), key="first"), 1)
                    anchor = next(item for item in parent_input.eligible
                                  if item.scope == "global" and item.candidate_id == "anchor")
                    child = next(item for item in parent_input.eligible
                                 if item.candidate_id != "anchor" and (
                                     item.scope.startswith("local:") if recipe is GEPA
                                     else item.scope == "global"
                                 ))
                    allocations = []
                    for index, (option, probability) in enumerate(((anchor, 0.25), (child, 0.75))):
                        option = replace(option, probability=probability)
                        selected.append(option)
                        allocations.append(ParentAllocation(rng.choice((option,), key=str(index)), 1))
                    return ParentPlan(tuple(allocations), "exercise both saved parent batches")

                def proposals(proposal_input):
                    received.append(proposal_input)
                    return ProposalPlan(
                        ("repair selected scope",), proposal_input.parent.task_ids, "selected parent",
                    )

                def algorithm():
                    return recipe(parent_policy=parents, proposal_planner=proposals)

                view = replace(
                    self.view(3), tasks=(Task("a", "first"), Task("b", "second")),
                    evidence=(
                        Evidence("anchor", "a", 0, 0.25, "valid", "global"),
                        Evidence("anchor", "b", 0, 0.5, "valid", "global"),
                    ),
                    budget=replace(self.view(3).budget, rounds=2),
                )
                view, decision = self.until(
                    algorithm(), view,
                    lambda value: bool(selected) and value.operations[0].kind == "diagnose_seed",
                )
                self.assertEqual(len(selected), 2)
                for index, option in enumerate(selected):
                    self.assertEqual(decision.state.data["policy_state"]["batch_index"], index)
                    self.assertEqual(decision.operations[0].task_ids, option.task_ids)
                    resumed = AlgorithmState(**json.loads(json.dumps(asdict(decision.state))))
                    view = advance(view, decision.operations, diagnosis={"detail": "repair"})
                    generated = algorithm().step(view, resumed)
                    self.assertEqual(received[-1].parent, option)
                    self.assertEqual(received[-1].diagnosis, {"detail": "repair"})
                    self.assertEqual(tuple(cell.task_id for cell in received[-1].failures), option.task_ids)
                    self.assertEqual(generated.operations[0].task_ids, option.task_ids)
                    self.assertEqual(generated.operations[0].parent_id, option.candidate_id)
                    # A failed generation receipt advances to the next saved parent batch.
                    view = advance(view, generated.operations, failing=lambda operation: True)
                    resumed = AlgorithmState(**json.loads(json.dumps(asdict(generated.state))))
                    decision = algorithm().step(view, resumed)
                self.assertEqual(len(received), 3)
                self.assertEqual(decision.operations[0].kind, "nominate")

    def test_exhausted_generation_does_not_discard_an_already_evaluated_nominee(self):
        view = self.view(0)
        view = replace(
            view, candidates=view.candidates + (Candidate("best", digest("best")),),
            evidence=view.evidence + (Evidence("best", "a", 0, 1, "valid", "global"),),
        )
        decision = decision_after_baseline(GEPA(), view)
        self.assertEqual(decision.operations[0].kind, "nominate")
        self.assertEqual(decision.operations[0].candidate_id, "best")
