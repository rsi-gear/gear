import json
import unittest
from dataclasses import replace

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
from gear.algorithms.rrsi.history import (
    normalize,
    novelty,
    prune_components,
    stalled,
    tried_components,
)
from gear.algorithms.rrsi.ranking import (
    RRSIRanker,
    cost_rule,
)
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

    def test_hard_check_rejection_triggers_repair(self):
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
        decision = algorithm.step(
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
        self.assertEqual(decision.operations[0].kind, "generate_candidate")
        self.assertEqual(decision.operations[0].candidate_id, "candidate-repair-1")
        self.assertIn("credential in diff", decision.operations[0].payload["meta"]["prompt"])

    def test_semantic_critic_rejection_triggers_repair(self):
        generated = OperationResult(
            "generation",
            "generate_candidate",
            "complete",
            "candidate",
            candidate_change={
                "files": [{"path": "x.py", "patch": "+# benign code\ndef solve(): pass\n"}],
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
            {"declined": False, "data": {"verdict": "reject", "reasons": ["inert change"]}},
        )
        second = algorithm.step(
            self.screening_view(None, completed=(generated, rejected)),
            first.state,
        )
        self.assertEqual(second.operations[0].kind, "generate_candidate")
        self.assertEqual(second.operations[0].candidate_id, "candidate-repair-1")
        self.assertIn("inert change", second.operations[0].payload["meta"]["prompt"])

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
        algorithm = RRSI(config=RRSIConfig(rounds=1))
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
        accepted = OperationResult(
            "critic",
            "diagnose_seed",
            "complete",
            "candidate",
            {"declined": False, "data": {"verdict": "accept"}},
        )
        second = algorithm.step(
            self.screening_view(None, completed=(generated, accepted)),
            first.state,
        )
        self.assertEqual(second.operations[0].kind, "evaluate_seed")

    def test_batch_screening_evaluates_only_accepted_candidates(self):
        gen0 = OperationResult(
            "gen0",
            "generate_candidate",
            "complete",
            "c0",
            candidate_change={
                "files": [{"path": "x.py", "patch": '+api_key = "fixture-secret-value"\n'}],
                "omitted_patches": 0,
            },
        )
        gen1 = OperationResult(
            "gen1",
            "generate_candidate",
            "complete",
            "c1",
            candidate_change={
                "files": [{"path": "y.py", "patch": "+clean = True\n"}],
                "omitted_patches": 0,
            },
        )
        algorithm = RRSI(config=RRSIConfig(rounds=1, max_repairs=0))
        view = SearchView(
            "run",
            1,
            "fixed",
            (Task("task", "format"),),
            (
                Candidate("anchor", digest("anchor")),
                Candidate("c0", digest("c0"), "anchor"),
                Candidate("c1", digest("c1"), "anchor"),
            ),
            (Evidence("anchor", "task", 0, 0.0, "valid", "global"),),
            (gen0, gen1),
            Budget(10, 2, 1, 1),
            "anchor",
        )
        # c0 has credentials (max_repairs=0 -> rejected). c1 is clean -> diagnose_seed for c1.
        d1 = algorithm.step(
            view,
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["c0", "c1"],
                    "parent": "anchor",
                    "failures": ["task"],
                    "round": 0,
                }
            ),
        )
        self.assertEqual(d1.operations[0].kind, "diagnose_seed")
        self.assertEqual(d1.operations[0].candidate_id, "c1")
        # c1 accepted by critic
        crit1 = OperationResult(
            "crit1",
            "diagnose_seed",
            "complete",
            "c1",
            {"declined": False, "data": {"verdict": "accept"}},
        )
        view2 = replace(view, completed=(gen0, gen1, crit1))
        d2 = algorithm.step(view2, d1.state)
        # Only c1 is evaluated, not c0!
        self.assertEqual(d2.operations[0].kind, "evaluate_seed")
        self.assertEqual(d2.state.data["planned"], ["c1"])
        eval_cands = [op.candidate_id for op in d2.operations if op.kind == "evaluate_seed"]
        self.assertIn("c1", eval_cands)
        self.assertNotIn("c0", eval_cands)

    def test_edit_budget_anneals_from_maximum_to_minimum(self):
        config = RRSIConfig(rounds=4, min_edit_budget=1, max_edit_budget=4)
        self.assertEqual(config.edit_budget(0), 4)
        self.assertEqual(config.edit_budget(4), 1)
        self.assertGreaterEqual(config.edit_budget(2), 1)

    def test_cost_rule_uses_gain_budget_and_noise_band(self):
        self.assertTrue(
            cost_rule(
                0.05,
                0.10 + 40 * 0.05 - 0.01,
                0,
                noise_delta=0.02,
                beta0=0.10,
                beta1=40.0,
                score_weight=100.0,
                cost_weight=15.0,
                novelty_weight=0.5,
            )
        )
        self.assertFalse(
            cost_rule(
                0.05,
                0.10 + 40 * 0.05 + 0.01,
                0,
                noise_delta=0.02,
                beta0=0.10,
                beta1=40.0,
                score_weight=100.0,
                cost_weight=15.0,
                novelty_weight=0.5,
            )
        )
        self.assertTrue(
            cost_rule(
                0.0,
                -0.10,
                0,
                noise_delta=0.02,
                beta0=0.10,
                beta1=40.0,
                score_weight=100.0,
                cost_weight=15.0,
                novelty_weight=0.5,
            )
        )
        self.assertFalse(
            cost_rule(
                0.0,
                0.10,
                0,
                noise_delta=0.02,
                beta0=0.10,
                beta1=40.0,
                score_weight=100.0,
                cost_weight=15.0,
                novelty_weight=0.5,
            )
        )
        self.assertTrue(
            cost_rule(
                0.0,
                0.0,
                1,
                noise_delta=0.02,
                beta0=0.10,
                beta1=40.0,
                score_weight=100.0,
                cost_weight=15.0,
                novelty_weight=0.5,
            )
        )

    def test_novelty_counts_only_unseen_structural_components(self):
        self.assertEqual(novelty(("skill", "prompt", "memory"), {"skill": 1}), 1)
        self.assertEqual(novelty(("prompt", "config"), {"skill": 0}), 0)
        self.assertEqual(novelty(("skill",), {"skill": 2}), 0)

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

    def test_ranker_rejects_candidate_below_historical_peak_floor(self):
        evidence = (
            Evidence(
                "incumbent",
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
        # S_star is 0.80. Floor is 0.80 - 0.02 = 0.78. Candidate score 0.77 < 0.78 -> rejected!
        ranked = RRSIRanker(RRSIConfig(noise_delta=0.02), score_star=0.80)(
            RankingInput(("incumbent", "candidate"), ("task",), evidence, 1, anchor_id="incumbent")
        )
        self.assertEqual(ranked.candidate_ids, ("incumbent",))
        self.assertEqual(ranked.disqualified, ("candidate",))

    def test_recipe_emits_rrsi_generation_directives(self):
        tasks = tuple(Task(name, "arithmetic") for name in ("a", "b"))
        anchor = Candidate("anchor", digest("anchor"))
        view = SearchView(
            "toy",
            0,
            "toy",
            tasks,
            (anchor,),
            (Evidence("anchor", "a", 0, 0.0, "valid", "global"),),
            (
                OperationResult("0:0", "evaluate_seed", "complete", "anchor"),
                OperationResult(
                    "0:1",
                    "diagnose_seed",
                    "complete",
                    "anchor",
                    data={"hypotheses": ["Fix arithmetic failures."]},
                ),
            ),
            Budget(
                evaluations_remaining=100,
                candidates_remaining=2,
                rounds=2,
                repetitions=1,
            ),
            "anchor",
        )
        algo = RRSI(config=RRSIConfig(rounds=2, max_edit_budget=3, noise_delta=0.04))
        state = AlgorithmState(
            data={
                "phase": "proposals",
                "parent": "anchor",
                "limit": 1,
                "failures": ["a"],
                "round": 0,
                "batches": [
                    {
                        "parent": "anchor",
                        "tasks": ["a"],
                        "count": 1,
                        "selection": {
                            "option": {
                                "candidate_id": "anchor",
                                "scope": "global",
                                "task_ids": ["a"],
                                "score": 0.0,
                                "probability": 1.0,
                                "task_scores": [["a", 0.0]],
                                "weights": [["a", 1.0]],
                                "content_digest": anchor.digest,
                            }
                        },
                    }
                ],
                "batch_index": 0,
            }
        )
        decision = algo.step(view, state)
        self.assertEqual(decision.operations[0].kind, "generate_candidate")
        meta = decision.operations[0].payload.get("meta", {})
        self.assertEqual(meta.get("edit_budget"), 3)
        self.assertEqual(meta.get("noise_delta"), 0.04)
        self.assertIn("stall", meta)
        self.assertIn("tried_components", meta)
        self.assertIn("prune_components", meta)
        self.assertIn("history", meta)

    def test_multi_round_improvement_nomination_preserved(self):
        result = toy_round(RRSI(config=RRSIConfig(rounds=2, max_edit_budget=3)))
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["nominee"], "r0-b0-candidate-0")

    def test_windowed_pruning_and_stall_flag(self):
        history = [
            {
                "t": 0,
                "candidate_id": "c0",
                "component": "prompt",
                "delta_S": 0.03,
                "accepted": True,
            },
            {
                "t": 1,
                "candidate_id": "c1",
                "component": "prompt",
                "delta_S": -0.01,
                "accepted": False,
            },
            {
                "t": 1,
                "candidate_id": "c2",
                "component": "skill",
                "delta_S": -0.02,
                "accepted": False,
            },
            {
                "t": 2,
                "candidate_id": "c3",
                "component": "config",
                "delta_S": None,
                "accepted": False,
            },
        ]
        self.assertEqual(tried_components(history), {"prompt", "skill"})
        # at t=3 with n_prune=4: prompt delta 0.03 is within window [0..3]
        self.assertEqual(prune_components(history, t=3, n_prune=4), ["skill"])
        # at t=5 with n_prune=4: t=0 prompt falls out of window [1..5], prompt recent best is -0.01 <= 0
        self.assertEqual(prune_components(history, t=5, n_prune=4), ["prompt", "skill"])

        traj = [0.50, 0.53, 0.53, 0.535, 0.60]
        self.assertFalse(stalled(traj, 3, 3, 0.02))  # 0.535 - 0.50 = 0.035 > 0.02
        self.assertTrue(stalled(traj, 3, 2, 0.02))  # 0.535 - 0.53 = 0.005 <= 0.02
        self.assertFalse(stalled(traj, 4, 2, 0.02))  # 0.60 - 0.53 = 0.07 > 0.02
        self.assertFalse(stalled(traj, 1, 3, 0.02))  # not enough history

    def test_component_normalization_from_diff(self):
        self.assertEqual(normalize("Skill", "", []), "prompt")
        self.assertEqual(normalize("Skill", "+++ b/x/skills/y/SKILL.md", []), "skill")
        self.assertEqual(normalize("bogus", "+++ b/harness/skills/x/SKILL.md", []), "skill")
        self.assertEqual(
            normalize(
                None, "+++ b/harness/resum.py\n+ keep_last = 5", [("context_mgmt", [r"resum\.py"])]
            ),
            "context_mgmt",
        )
        self.assertEqual(normalize(None, "nothing structural", []), "prompt")

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
