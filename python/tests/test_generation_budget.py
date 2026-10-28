"""Author recipes adapt their plans to core-owned generation capacity."""
import json
import unittest
from dataclasses import replace

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
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
            'generation-budget', 1, 'fixed', (Task('a', 'family'),),
            (Candidate('anchor', digest('anchor')),),
            (Evidence('anchor', 'a', 0, 0, 'valid', 'global'),), (),
            Budget(20, 3, 1, generation_requests_remaining=capacity,
                   generation_tokens_remaining=capacity, generation_batch_capacity=capacity),
            'anchor',
        )

    def test_exhaustion_stops_before_another_diagnosis_or_generation(self):
        for recipe in (GEPA, RandomSearch):
            view = self.view(0)
            for state in (
                AlgorithmState(data={'phase': 'parents', 'round': 0}),
                AlgorithmState(data={'phase': 'proposals', 'round': 0}),
            ):
                with self.subTest(recipe=recipe.__name__, phase=state.data['phase']):
                    decision = recipe().step(view, state)
                    self.assertEqual(decision.operations[0].kind, 'stop')
                    self.assertIn('generation budget exhausted', decision.reason)

    def test_proposal_count_is_bounded_by_affordable_batch_capacity(self):
        for recipe in (GEPA, RandomSearch):
            view = replace(self.view(1), completed=(OperationResult(
                'diagnosis', 'diagnose_seed', 'complete', 'anchor',
                {'hypotheses': ['one', 'two', 'three']},
            ),))
            state = recipe().step(
                view, AlgorithmState(data={'phase': 'parents', 'round': 0})
            ).state
            decision = recipe().step(view, state)
            self.assertEqual(len(decision.operations), 1)
            self.assertEqual(decision.operations[0].kind, 'generate_candidate')

    def test_planner_receives_selected_parent_after_json_resume_and_batch_advance(self):
        for recipe in (GEPA, RandomSearch):
            with self.subTest(recipe=recipe.__name__):
                selected = []
                received = []

                def parents(parent_input, rng):
                    allocations = []
                    for scope, probability in (("global", 0.25), ("local:toy", 0.75)):
                        option = replace(
                            next(item for item in parent_input.eligible if item.scope == scope),
                            probability=probability,
                        )
                        selected.append(option)
                        allocations.append(ParentAllocation(rng.choice((option,), key=scope), 1))
                    return ParentPlan(tuple(allocations), "exercise both parent scopes")

                def proposals(proposal_input):
                    received.append(proposal_input)
                    return ProposalPlan(
                        ("repair selected scope",),
                        proposal_input.parent.task_ids,
                        "selected parent",
                    )

                algorithm = recipe(parent_policy=parents, proposal_planner=proposals)
                view = replace(
                    self.view(3),
                    tasks=(Task("a", "first"), Task("b", "second")),
                    evidence=(
                        Evidence("anchor", "a", 0, 0.25, "valid", "global"),
                        Evidence("anchor", "b", 0, 0.5, "valid", "global"),
                    ),
                )
                decision = algorithm.step(
                    view,
                    AlgorithmState(
                        data={
                            "phase": "parents",
                            "round": 0,
                            "scopes": [{"scope": "local:toy", "tasks": ["a"], "weights": {"a": 1}}],
                        }
                    ),
                )
                for index, option in enumerate(selected):
                    self.assertEqual(decision.state.data["batch_index"], index)
                    self.assertEqual(decision.operations[0].task_ids, option.task_ids)
                    resumed = AlgorithmState(data=json.loads(json.dumps(decision.state.data)))
                    diagnosed = replace(
                        view,
                        completed=(
                            OperationResult(
                                "diagnosis",
                                "diagnose_seed",
                                "complete",
                                "anchor",
                                {"detail": "repair"},
                            ),
                        ),
                    )
                    generated = algorithm.step(diagnosed, resumed)
                    self.assertEqual(received[-1].parent, option)
                    self.assertEqual(received[-1].diagnosis, {"detail": "repair"})
                    self.assertEqual(
                        tuple(cell.task_id for cell in received[-1].failures), option.task_ids
                    )
                    self.assertEqual(generated.operations[0].task_ids, option.task_ids)
                    self.assertEqual(generated.operations[0].parent_id, option.candidate_id)
                    # No completed generation advances to the next saved parent batch.
                    decision = algorithm.step(view, generated.state)

    def test_exhausted_generation_does_not_discard_an_already_evaluated_nominee(self):
        view = replace(self.view(0), candidates=self.view(0).candidates + (Candidate('best', digest('best')),),
            evidence=self.view(0).evidence + (Evidence('best', 'a', 0, 1, 'valid', 'global'),))
        decision = GEPA().step(view, AlgorithmState(data={'phase': 'proposals', 'round': 0}))
        self.assertEqual(decision.operations[0].kind, 'nominate')
        self.assertEqual(decision.operations[0].candidate_id, 'best')
