"""CPU regression coverage for the GEPA promotion cohort and its evaluation cost."""

import json
import unittest
from dataclasses import asdict, replace

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    RandomSearch,
    SearchView,
    Task,
)
from gear.algorithms.contracts import OperationResult, RankingPlan
from gear.algorithms.workflow import StagedSearch
from gear.algorithms.gepa.ranking import rank_candidates
from gear.algorithms.testkit import wire
from gear.canonical import digest
from gear.project import Project
from gear.refine.protocol import validate
from gear.refine.worker import decode_view, make_algorithm


def candidate_id(index):
    return f"r0-b0-candidate-{index}"


class StagedPromotionTests(unittest.TestCase):
    def run_search(
        self,
        algorithm=None,
        *,
        task_count=100,
        candidate_count=4,
        evaluation_budget=None,
        relative_local_score=None,
        incomplete=False,
    ):
        """Execute real decisions while reusing evaluated cells as the core does."""
        algorithm = algorithm or GEPA()
        failures = tuple(str(index) for index in range(task_count // 5))
        view = SearchView(
            "promotion",
            0,
            "fixed-promotion-seed",
            tuple(
                Task(str(index), "failure" if str(index) in failures else "control")
                for index in range(task_count)
            ),
            (Candidate("anchor", digest("anchor")),),
            (),
            (),
            Budget(
                evaluation_budget if evaluation_budget is not None else task_count * 10,
                candidate_count,
                1,
            ),
            "anchor",
        )
        state = AlgorithmState()
        operations = []
        research = []
        local_tasks = set()
        cells = {}
        for _ in range(20):
            decision = algorithm.step(view, state)
            validate("Decision", wire(decision))
            # A resumed worker receives JSON, including list-valued state fields.
            resumed = algorithm.step(
                decode_view(wire(view)),
                AlgorithmState(**json.loads(json.dumps(asdict(state)))),
            )
            self.assertEqual(wire(decision), wire(resumed))
            self.assertTrue(decision.operations)
            state = decision.state
            research.extend(decision.research)
            for index, operation in enumerate(decision.operations):
                operations.append(operation)
                if operation.kind in ("nominate", "stop"):
                    return view, operations, research
                result = OperationResult(
                    f"{view.step_id}:{index}",
                    operation.kind,
                    "complete",
                    operation.candidate_id,
                )
                if operation.kind == "diagnose_seed":
                    result = replace(
                        result,
                        data={
                            "clusters": [{
                                "task_ids": list(failures),
                                "hypotheses": [f"proposal {i}" for i in range(candidate_count)],
                            }],
                        },
                    )
                elif operation.kind == "generate_candidate":
                    self.assertGreater(view.budget.candidates_remaining, 0)
                    view = replace(
                        view,
                        candidates=view.candidates + (Candidate(
                            operation.candidate_id,
                            digest(operation.candidate_id),
                            operation.parent_id,
                        ),),
                        budget=replace(
                            view.budget,
                            candidates_remaining=view.budget.candidates_remaining - 1,
                        ),
                    )
                elif operation.kind == "evaluate_seed":
                    stage = operation.scope.split(":", 1)[0]
                    if stage == "local":
                        local_tasks.update(operation.task_ids)
                    before = len(cells)
                    for task in operation.task_ids:
                        key = (operation.candidate_id, task, 0)
                        if key in cells:
                            continue
                        parent_score = float(task not in failures)
                        score = parent_score
                        status = "valid"
                        if operation.candidate_id != "anchor":
                            candidate_index = int(operation.candidate_id.rsplit("-", 1)[1])
                            if task in local_tasks:
                                score = (
                                    parent_score * relative_local_score
                                    if relative_local_score is not None
                                    else 1 - candidate_index / 10
                                )
                            else:
                                score = float(candidate_index == 1)
                            if incomplete and candidate_index == 3:
                                score, status = None, "scoring_failed"
                        cells[key] = Evidence(
                            operation.candidate_id, task, 0, score, status, operation.scope
                        )
                    cost = len(cells) - before
                    self.assertLessEqual(cost, view.budget.evaluations_remaining)
                    view = replace(
                        view,
                        evidence=tuple(cells.values()),
                        budget=replace(
                            view.budget,
                            evaluations_remaining=view.budget.evaluations_remaining - cost,
                        ),
                    )
                view = replace(view, completed=view.completed + (result,))
            view = replace(view, step_id=view.step_id + 1)
        self.fail("search did not terminate")

    @staticmethod
    def cohorts(operations):
        cohorts = {}
        for operation in operations:
            if operation.kind == "evaluate_seed" and operation.candidate_id != "anchor":
                stage = operation.scope.split(":", 1)[0]
                cohorts.setdefault(stage, []).append(operation.candidate_id)
        return cohorts

    def test_default_promotes_two_then_one_and_second_candidate_can_win(self):
        view, operations, research = self.run_search()
        self.assertEqual(self.cohorts(operations), {
            "local": [candidate_id(i) for i in range(4)],
            "bridge": [candidate_id(0), candidate_id(1)],
            "global": [candidate_id(1)],
        })
        rankings = [record for record in research if record.kind == "ranking"]
        self.assertEqual(rankings[0].data["ranking"]["candidate_ids"][:2],
                         [candidate_id(0), candidate_id(1)])
        self.assertEqual(rankings[1].data["ranking"]["candidate_ids"][0], candidate_id(1))
        self.assertEqual(operations[-1].kind, "nominate")
        self.assertEqual(operations[-1].candidate_id, candidate_id(1))
        self.assertEqual(len(view.evidence), 270)

    def test_equal_or_worse_local_scores_still_receive_broader_evidence(self):
        for relative_score in (1.0, 0.5):
            with self.subTest(relative_local_score=relative_score):
                _, operations, research = self.run_search(relative_local_score=relative_score)
                self.assertEqual(self.cohorts(operations)["bridge"],
                                 [candidate_id(0), candidate_id(1)])
                local_rank = next(record for record in research if record.kind == "ranking")
                scores = dict(local_rank.data["ranking"]["scores"])
                for index in range(4):
                    self.assertLessEqual(scores[candidate_id(index)], scores["anchor"])
                self.assertEqual(operations[-1].kind, "nominate")
                self.assertEqual(operations[-1].candidate_id, candidate_id(1))

    def test_default_sampler_charges_only_new_cells_at_each_stage(self):
        for count in (100, 1000):
            with self.subTest(task_count=count):
                view, operations, _ = self.run_search(task_count=count)
                cohorts = self.cohorts(operations)
                self.assertEqual({stage: len(ids) for stage, ids in cohorts.items()},
                                 {"local": 4, "bridge": 2, "global": 1})
                by_stage = {}
                for cell in view.evidence:
                    if cell.candidate_id != "anchor":
                        stage = cell.scope.split(":", 1)[0]
                        by_stage[stage] = by_stage.get(stage, 0) + 1
                self.assertEqual(by_stage, {
                    "local": count * 60 // 100,
                    "bridge": count * 50 // 100,
                    "global": count * 60 // 100,
                })
                self.assertEqual(sum(by_stage.values()), count * 170 // 100)
                self.assertEqual(len(view.evidence), count + count * 170 // 100)

    def test_insufficient_budget_does_not_start_an_unaffordable_cohort(self):
        for budget, expected_stages, expected_cells in (
            (159, [], 100),
            (209, ["local"], 160),
            (269, ["local", "bridge"], 210),
        ):
            with self.subTest(evaluation_budget=budget):
                view, operations, _ = self.run_search(evaluation_budget=budget)
                self.assertEqual(list(self.cohorts(operations)), expected_stages)
                self.assertEqual(len(view.evidence), expected_cells)
                self.assertEqual(view.budget.evaluations_remaining, budget - expected_cells)
                self.assertEqual(operations[-1].kind, "stop")

    def test_widths_are_configurable_and_do_not_duplicate_small_cohorts(self):
        _, operations, _ = self.run_search(GEPA(promotion_widths=(3, 2)))
        self.assertEqual({stage: len(ids) for stage, ids in self.cohorts(operations).items()},
                         {"local": 4, "bridge": 3, "global": 2})
        _, operations, _ = self.run_search(candidate_count=1)
        self.assertEqual(self.cohorts(operations), {
            "local": [candidate_id(0)],
            "bridge": [candidate_id(0)],
            "global": [candidate_id(0)],
        })
        # Complete global evidence remains necessary, and a worse candidate cannot win it.
        self.assertEqual(operations[-1].kind, "stop")

    def test_disqualified_candidates_are_skipped_before_applying_width(self):
        def rank_with_disqualified_candidate(view):
            return replace(rank_candidates(view), disqualified=(candidate_id(0),))

        _, operations, _ = self.run_search(GEPA(ranker=rank_with_disqualified_candidate))
        self.assertEqual(self.cohorts(operations)["bridge"],
                         [candidate_id(1), candidate_id(2)])
        self.assertEqual(self.cohorts(operations)["global"], [candidate_id(1)])

    def test_incomplete_evidence_blocks_the_entire_cohort(self):
        _, operations, _ = self.run_search(incomplete=True)
        self.assertEqual(list(self.cohorts(operations)), ["local"])
        self.assertEqual(operations[-1].kind, "stop")

    def test_promotion_configuration_survives_sdk_and_worker_json(self):
        for widths in ((2, 1), (3, 2)):
            with self.subTest(promotion_widths=widths):
                config = json.loads(json.dumps(Project._describe_algorithm(
                    GEPA(promotion_widths=widths)
                )))
                self.assertEqual(config["algorithm"]["options"]["promotion_widths"],
                                 list(widths))
                restored = make_algorithm(config["algorithm"])
                self.assertEqual(restored.promotion_widths, widths)
                self.assertIsInstance(restored.promotion_widths, tuple)
                _, original, _ = self.run_search(GEPA(promotion_widths=widths))
                _, resumed, _ = self.run_search(restored)
                self.assertEqual(original, resumed)

    def test_invalid_promotion_widths_are_rejected(self):
        for widths in ((), (1,), (2, 1, 1), (0, 1), (-1, 1), (2, True), (2, 1.5), (2, "1")):
            with self.subTest(promotion_widths=widths):
                with self.assertRaises(ValueError):
                    GEPA(promotion_widths=widths)

    def test_no_regression_gate_spends_global_seed_only_on_matching_candidates(self):
        gated = GEPA(promotion_widths=(3, 2), global_gate="no_regression")
        view, operations, _ = self.run_search(gated)
        self.assertEqual(self.cohorts(operations)["global"], [candidate_id(1)])
        self.assertEqual(operations[-1].candidate_id, candidate_id(1))
        ungated, _, _ = self.run_search(GEPA(promotion_widths=(3, 2)))
        self.assertEqual(len(ungated.evidence) - len(view.evidence), 60)

        view, operations, _ = self.run_search(
            GEPA(global_gate="no_regression"), candidate_count=1
        )
        self.assertEqual(list(self.cohorts(operations)), ["local", "bridge"])
        self.assertEqual(operations[-1].kind, "stop")
        ungated, _, _ = self.run_search(candidate_count=1)
        self.assertEqual(len(ungated.evidence) - len(view.evidence), 60)

    def test_no_regression_gate_advances_ties(self):
        def rank_as_ties(view):
            ranked = rank_candidates(view)
            return replace(ranked, scores=tuple((candidate, 0.5) for candidate, _ in ranked.scores))

        _, operations, _ = self.run_search(GEPA(ranker=rank_as_ties, global_gate="no_regression"))
        self.assertEqual(len(self.cohorts(operations)["global"]), 1)

    def test_no_regression_gate_advances_a_candidate_that_repairs_parent_constraints(self):
        def rank_with_disqualified_anchor(view):
            ranked = rank_candidates(view)
            scores = tuple(
                (candidate, 0.9 if candidate == "anchor" else 0.5) for candidate, _ in ranked.scores
            )
            return replace(ranked, scores=scores, disqualified=("anchor",))

        _, operations, _ = self.run_search(
            GEPA(ranker=rank_with_disqualified_anchor, global_gate="no_regression")
        )
        self.assertEqual(len(self.cohorts(operations)["global"]), 1)
        self.assertEqual(operations[-1].kind, "nominate")

    def test_no_regression_gate_compares_objective_scores_at_their_precision(self):
        view = SearchView(
            "gate", 0, "seed", (), (), (), (), Budget(1, 1, 1), "anchor",
            {"definition": {"comparisonPrecision": 0.01}},
        )
        # 0.699 and 0.7 round to the same 0.01 step, so the candidate ties the parent.
        ranked = RankingPlan(("anchor", "c"), (("anchor", 0.7), ("c", 0.699)), ())
        self.assertTrue(StagedSearch._at_least(view, ranked, "c", "anchor"))
        ranked = RankingPlan(("anchor", "c"), (("anchor", 0.72), ("c", 0.7)), ())
        self.assertFalse(StagedSearch._at_least(view, ranked, "c", "anchor"))

    def test_global_gate_survives_sdk_and_worker_json_and_default_is_omitted(self):
        default = Project._describe_algorithm(GEPA())
        self.assertNotIn("global_gate", default["algorithm"]["options"])
        config = json.loads(json.dumps(Project._describe_algorithm(
            GEPA(global_gate="no_regression")
        )))
        self.assertEqual(config["algorithm"]["options"]["global_gate"], "no_regression")
        self.assertEqual(make_algorithm(config["algorithm"]).global_gate, "no_regression")
        for value in ("strict", "", None):
            with self.subTest(global_gate=value), self.assertRaises(ValueError):
                GEPA(global_gate=value)

    def test_random_search_remains_a_single_global_cohort(self):
        algorithm = RandomSearch()
        self.assertEqual(algorithm.promotion_widths, ())
        view, operations, _ = self.run_search(algorithm)
        self.assertEqual(self.cohorts(operations), {
            "global": [candidate_id(i) for i in range(4)],
        })
        self.assertEqual(len(view.evidence), 500)
        self.assertEqual(operations[-1].kind, "nominate")
        self.assertEqual(operations[-1].candidate_id, candidate_id(1))
