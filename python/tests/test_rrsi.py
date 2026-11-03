import json
import unittest

from gear.algorithms import (
    RRSI,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    RankingInput,
    RRSIConfig,
    SearchView,
    Task,
)
from gear.algorithms.rrsi.ranking import RRSIRanker, cost_rule, novelty
from gear.algorithms.testkit import toy_round
from gear.canonical import digest
from gear.project import Project
from gear.refine.worker import make_algorithm


class RRSITests(unittest.TestCase):
    @staticmethod
    def screening_view(change, *, candidate_id="candidate", completed=()):
        return SearchView(
            "run",
            1,
            "fixed",
            (Task("task", "format"),),
            (
                Candidate("anchor", digest("anchor")),
                Candidate(candidate_id, digest(candidate_id), "anchor"),
            ),
            (Evidence("anchor", "task", 0, 0.0, "valid", "global"),),
            tuple(completed),
            Budget(10, 2, 1, 1),
            "anchor",
        )

    def test_incomplete_change_rejects_without_evaluation(self):
        result = OperationResult("generation", "generate_candidate", "complete", "candidate")
        decision = RRSI(config=RRSIConfig(rounds=1)).step(
            self.screening_view(None, completed=(result,)),
            AlgorithmState(
                data={"phase": "generated", "planned": ["candidate"], "parent": "anchor"}
            ),
        )
        self.assertEqual(decision.operations[0].kind, "stop")
        self.assertIn("rejected", decision.state.data)

    def test_suspicious_change_requests_critic_then_repairs(self):
        generated = OperationResult(
            "generation",
            "generate_candidate",
            "complete",
            "candidate",
            candidate_change={
                "files": [{"path": "x.py", "patch": '+api_key = "secret-value"\n'}],
                "omitted_patches": 0,
            },
        )
        algorithm = RRSI(config=RRSIConfig(rounds=1, max_repairs=1))
        first = algorithm.step(
            self.screening_view(None, completed=(generated,)),
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["candidate"],
                    "parent": "anchor",
                    "failures": ["task"],
                    "round": 0,
                }
            ),
        )
        self.assertEqual(first.operations[0].kind, "diagnose_seed")
        self.assertIn("meta", first.operations[0].payload)
        rejected = OperationResult(
            "critic",
            "diagnose_seed",
            "complete",
            "candidate",
            {"data": {"verdict": "reject", "reason": "credential"}},
        )
        second = algorithm.step(
            self.screening_view(None, completed=(generated, rejected)),
            first.state,
        )
        self.assertEqual(second.operations[0].kind, "generate_candidate")
        self.assertNotEqual(second.operations[0].candidate_id, "candidate")

    def test_clean_change_is_evaluated_after_screening(self):
        generated = OperationResult(
            "generation",
            "generate_candidate",
            "complete",
            "candidate",
            candidate_change={
                "files": [{"path": "x.py", "patch": "+retry = True\n"}],
                "omitted_patches": 0,
            },
        )
        decision = RRSI(config=RRSIConfig(rounds=1)).step(
            self.screening_view(None, completed=(generated,)),
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["candidate"],
                    "parent": "anchor",
                    "failures": ["task"],
                    "round": 0,
                }
            ),
        )
        self.assertEqual(decision.operations[0].kind, "evaluate_seed")

    def test_edit_budget_anneals_from_maximum_to_minimum(self):
        config = RRSIConfig(rounds=4, min_edit_budget=1, max_edit_budget=4)
        self.assertEqual(config.edit_budget(0), 4)
        self.assertEqual(config.edit_budget(4), 1)
        self.assertGreaterEqual(config.edit_budget(2), 1)

    def test_cost_rule_uses_gain_budget_and_noise_band(self):
        self.assertTrue(
            cost_rule(
                0.1,
                0.2,
                0,
                noise_delta=0.01,
                beta0=0.1,
                beta1=2,
                score_weight=100,
                cost_weight=15,
                novelty_weight=0.5,
            )
        )
        self.assertTrue(
            cost_rule(
                0.005,
                0,
                1,
                noise_delta=0.01,
                beta0=0.1,
                beta1=2,
                score_weight=100,
                cost_weight=15,
                novelty_weight=0.5,
            )
        )

    def test_novelty_counts_only_unseen_structural_components(self):
        self.assertEqual(novelty(("skill", "prompt", "memory"), {"skill": 1}), 1)

    def test_ranker_disqualifies_candidate_that_exceeds_cost_rule(self):
        evidence = (
            Evidence(
                "anchor",
                "task",
                0,
                0.5,
                "valid",
                "global",
                raw_metrics={"policy_tokens": {"value": 100}},
            ),
            Evidence(
                "candidate",
                "task",
                0,
                0.5,
                "valid",
                "global",
                raw_metrics={"policy_tokens": {"value": 1000}},
            ),
        )
        ranked = RRSIRanker(RRSIConfig(beta0=0, beta1=0))(
            RankingInput(("anchor", "candidate"), ("task",), evidence, 1, anchor_id="anchor")
        )
        self.assertEqual(ranked.candidate_ids, ("anchor",))
        self.assertEqual(ranked.disqualified, ("candidate",))

    def test_ranker_can_select_a_lower_score_candidate_with_a_cost_reduction(self):
        evidence = (
            Evidence(
                "anchor",
                "task",
                0,
                0.78,
                "valid",
                "global",
                raw_metrics={"policy_tokens": {"value": 100}},
            ),
            Evidence(
                "candidate",
                "task",
                0,
                0.77,
                "valid",
                "global",
                raw_metrics={"policy_tokens": {"value": 80}},
            ),
        )
        ranked = RRSIRanker(RRSIConfig(noise_delta=0.02))(
            RankingInput(("anchor", "candidate"), ("task",), evidence, 1, anchor_id="anchor")
        )
        self.assertEqual(ranked.candidate_ids, ("candidate", "anchor"))

    def test_recipe_emits_rrsi_generation_directives(self):
        result = toy_round(RRSI(config=RRSIConfig(rounds=2, max_edit_budget=3)))
        self.assertEqual(result["status"], "passed")
        self.assertIsNotNone(result["nominee"])

    def test_configuration_round_trip_preserves_nested_settings(self):
        algorithm = RRSI(config=RRSIConfig(rounds=7, candidates=3, noise_delta=0.04))
        frozen = json.loads(json.dumps(Project._describe_algorithm(algorithm)["algorithm"]))
        restored = make_algorithm(frozen)
        self.assertEqual(restored.config.rounds, 7)
        self.assertEqual(restored.config.candidates, 3)
        self.assertEqual(restored.config.noise_delta, 0.04)
        self.assertEqual(restored.ranker.config.noise_delta, 0.04)
        self.assertEqual(restored.stop_rule.config.rounds, 7)


if __name__ == "__main__":
    unittest.main()
