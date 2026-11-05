"""Committed offline differential tests against pinned reference RRSI (be50316e1db05914068a973f322770ef08ed7ba1).

Verifies multi-round incumbent transitions, S* retention, cost-rule branches,
actual structural novelty, windowed pruning, stall from incumbent trajectory,
and critic-before-eval screening.
"""

import math
import unittest

from gear.algorithms import (
    RRSI,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    RRSIConfig,
    SearchView,
    Task,
)
from gear.algorithms.rrsi.history import (
    normalize,
    prune_components,
    stalled,
    tried_components,
)
from gear.algorithms.rrsi.ranking import (
    admissible,
    cost_rule,
)
from gear.algorithms.testkit import toy_round
from gear.canonical import digest


class RRSIDifferentialTests(unittest.TestCase):
    def test_annealed_edit_budget_matches_reference_cosine_schedule(self):
        # Reference eq: ceil(bmin + (bmax - bmin) * 0.5 * (1 + cos(pi * t / T)))
        T, bmin, bmax = 20, 1, 4
        cfg = RRSIConfig(rounds=T, min_edit_budget=bmin, max_edit_budget=bmax)
        for t in range(T + 5):
            clamped_t = max(0, min(t, T))
            expected = int(
                math.ceil(
                    round(
                        bmin + (bmax - bmin) * 0.5 * (1 + math.cos(math.pi * clamped_t / T)),
                        9,
                    )
                )
            )
            self.assertEqual(cfg.edit_budget(t), expected)
        self.assertEqual(cfg.edit_budget(0), bmax)
        self.assertEqual(cfg.edit_budget(T), bmin)

    def test_cost_rule_differential_both_branches(self):
        # Parameter configuration from reference: beta0=0.10, beta1=40.0, w_s=100.0, w_c=15.0, w_n=0.5
        delta = 0.02
        kw = {
            "noise_delta": delta,
            "beta0": 0.10,
            "beta1": 40.0,
            "score_weight": 100.0,
            "cost_weight": 15.0,
            "novelty_weight": 0.5,
        }

        # 1. Gain exceeds delta: cost rule budget
        # Budget = 0.10 + 40.0 * 0.05 = 2.10
        self.assertTrue(cost_rule(0.05, 2.09, 0, **kw))
        self.assertFalse(cost_rule(0.05, 2.11, 0, **kw))

        # 2. Within or below noise delta: shaped score
        # dS=0.0, dC=-0.10, nov=0: shaped = 100*0 - 15*(-0.1) + 0.5*0 = +1.5 > 0 -> True
        self.assertTrue(cost_rule(0.0, -0.10, 0, **kw))
        # dS=0.0, dC=0.10, nov=0: shaped = -1.5 <= 0 -> False
        self.assertFalse(cost_rule(0.0, 0.10, 0, **kw))
        # dS=0.0, dC=0.0, nov=1: shaped = +0.5 > 0 -> True
        self.assertTrue(cost_rule(0.0, 0.0, 1, **kw))
        # dS=0.01 (<= 0.02), dC=0.1, nov=1: shaped = 100*0.01 - 15*0.1 + 0.5*1 = 1 - 1.5 + 0.5 = 0.0 <= 0 -> False
        self.assertFalse(cost_rule(0.01, 0.1, 1, **kw))

    def test_admissible_floor_boundary_retains_historical_s_star(self):
        # Provably rejects when falling below S* - delta, even if incumbent has lowered
        # Historical peak S*=0.80, current incumbent S=0.78, delta=0.02 -> floor is 0.78
        # Candidate S'=0.77: below 0.78 floor, so must be rejected!
        kw = {
            "noise_delta": 0.02,
            "beta0": 0.10,
            "beta1": 40.0,
            "score_weight": 100.0,
            "cost_weight": 15.0,
            "novelty_weight": 0.5,
        }
        self.assertFalse(
            admissible(
                score=0.77,
                incumbent_score=0.78,
                score_star=0.80,
                delta_score=-0.01,
                delta_cost=-0.20,
                novelty_value=0,
                **kw,
            )
        )
        # S'=0.78 meets floor 0.80 - 0.02 = 0.78 and saves cost (-20%):
        # shaped = 100*0 - 15*(-0.2) + 0 = 3.0 > 0 -> admissible
        self.assertTrue(
            admissible(
                score=0.78,
                incumbent_score=0.78,
                score_star=0.80,
                delta_score=0.0,
                delta_cost=-0.20,
                novelty_value=0,
                **kw,
            )
        )

    def test_multi_round_incumbent_inheritance_and_nomination(self):
        # Round 0 improves: 0.5 -> 0.6. Round 1 has no improvement: 0.6 -> 0.6.
        # Run must finalize nominating the Round 0 winner, NOT stop with None!
        algo = RRSI(config=RRSIConfig(rounds=2, max_edit_budget=3))
        result = toy_round(algo)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["nominee"], "r0-b0-candidate-0")

    def test_history_windowed_pruning_and_stall_trajectory(self):
        # History records with round indices
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
                "t": 1,
                "candidate_id": "c3",
                "component": "memory",
                "delta_S": -0.02,
                "accepted": False,
            },
            {
                "t": 2,
                "candidate_id": "c4",
                "component": "config",
                "delta_S": None,
                "accepted": False,
                "outcome": "critic_reject",
            },
        ]
        # Critic rejected candidate does not enter tried components
        self.assertEqual(tried_components(history), {"prompt", "skill", "memory"})

        # At t=3 with n_prune=4: t=0 prompt (+0.03) is within [0..3], so prompt is not pruned
        self.assertEqual(prune_components(history, t=3, n_prune=4), ["memory", "skill"])

        # At t=5 with n_prune=4: t=0 prompt falls out of window [1..5]. Recent best for prompt is -0.01 <= 0.
        self.assertEqual(prune_components(history, t=5, n_prune=4), ["memory", "prompt", "skill"])

        # Incumbent trajectory stall check: one incumbent score per round
        # Insertion order [.5,.6,.7,.1,.8,.2,.9] vs true incumbent [.5,.7,.8,.9]
        incumbent_traj = [0.5, 0.7, 0.8, 0.9]
        # At t=3 with window 3 and delta 0.01: 0.9 - 0.5 = 0.4 > 0.01 -> NOT stalled!
        self.assertFalse(stalled(incumbent_traj, 3, 3, 0.01))

        # Stalled trajectory:
        stalled_traj = [0.5, 0.53, 0.53, 0.535]
        # At t=3 with window 2: 0.535 - 0.53 = 0.005 <= 0.02 -> STALLED!
        self.assertTrue(stalled(stalled_traj, 3, 2, 0.02))

    def test_component_signals_and_diff_normalization(self):
        # Verifies component normalization matches pinned reference regex signals
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

    def test_critic_precheck_rejects_credentials_and_verifier_leaks(self):
        algo = RRSI(config=RRSIConfig(rounds=1, max_repairs=0))

        # 1. Credential rejection (constructed dynamically to avoid static secret scanner false positives)
        dummy_cred = "AI" + "za" + ("0" * 35)
        res_cred = OperationResult(
            "gen",
            "generate_candidate",
            "complete",
            "c_cred",
            candidate_change={
                "files": [
                    {
                        "path": "x.py",
                        "patch": f'+token = "{dummy_cred}"\n',
                    }
                ],
                "omitted_patches": 0,
            },
        )
        view = SearchView(
            "run",
            1,
            "fixed",
            (Task("t", "fmt"),),
            (
                Candidate("anchor", digest("anchor")),
                Candidate("c_cred", digest("c_cred"), "anchor"),
            ),
            (Evidence("anchor", "t", 0, 0.0, "valid", "global"),),
            (res_cred,),
            Budget(10, 1, 1, 1),
            "anchor",
        )
        d_cred = algo.step(
            view,
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["c_cred"],
                    "parent": "anchor",
                    "failures": ["t"],
                    "round": 0,
                }
            ),
        )
        self.assertEqual(d_cred.operations[0].kind, "stop")
        self.assertIn("credential in diff", str(d_cred.state.data.get("rejected")))

        # 2. Oracle solution path rejection (/solution/solve.sh)
        res_sol = OperationResult(
            "gen",
            "generate_candidate",
            "complete",
            "c_sol",
            candidate_change={
                "files": [{"path": "agent.py", "patch": "+cat /solution/solve.sh\n"}],
                "omitted_patches": 0,
            },
        )
        view_sol = SearchView(
            "run",
            1,
            "fixed",
            (Task("t", "fmt"),),
            (Candidate("anchor", digest("anchor")), Candidate("c_sol", digest("c_sol"), "anchor")),
            (Evidence("anchor", "t", 0, 0.0, "valid", "global"),),
            (res_sol,),
            Budget(10, 1, 1, 1),
            "anchor",
        )
        d_sol = algo.step(
            view_sol,
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["c_sol"],
                    "parent": "anchor",
                    "failures": ["t"],
                    "round": 0,
                }
            ),
        )
        self.assertEqual(d_sol.operations[0].kind, "stop")
        self.assertIn("verifier/solution leak", str(d_sol.state.data.get("rejected")))

        # 3. Benign type annotation def solve(task_id: str): ... is NOT rejected by hard check
        res_benign = OperationResult(
            "gen",
            "generate_candidate",
            "complete",
            "c_benign",
            candidate_change={
                "files": [
                    {
                        "path": "agent.py",
                        "patch": "+def solve(task_id: str, prompt: str):\n+    return prompt\n",
                    }
                ],
                "omitted_patches": 0,
            },
        )
        view_benign = SearchView(
            "run",
            1,
            "fixed",
            (Task("t", "fmt"),),
            (
                Candidate("anchor", digest("anchor")),
                Candidate("c_benign", digest("c_benign"), "anchor"),
            ),
            (Evidence("anchor", "t", 0, 0.0, "valid", "global"),),
            (res_benign,),
            Budget(10, 1, 1, 1),
            "anchor",
        )
        d_benign = algo.step(
            view_benign,
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["c_benign"],
                    "parent": "anchor",
                    "failures": ["t"],
                    "round": 0,
                }
            ),
        )
        # Survived hard check -> advances to semantic review via diagnose_seed!
        self.assertEqual(d_benign.operations[0].kind, "diagnose_seed")
        self.assertEqual(d_benign.operations[0].candidate_id, "c_benign")

    def test_zero_benchmark_evaluations_for_rejected_candidates(self):
        # A candidate rejected by critic causes 0 evaluate_seed operations
        gen_rejected = OperationResult(
            "gen",
            "generate_candidate",
            "complete",
            "cand",
            candidate_change={
                "files": [{"path": "x.py", "patch": '+api_key = "invalid-secret-key-fixture"\n'}],
                "omitted_patches": 0,
            },
        )
        view = SearchView(
            "run",
            1,
            "fixed",
            (Task("t", "fmt"),),
            (Candidate("anchor", digest("anchor")), Candidate("cand", digest("cand"), "anchor")),
            (Evidence("anchor", "t", 0, 0.0, "valid", "global"),),
            (gen_rejected,),
            Budget(10, 1, 1, 1),
            "anchor",
        )
        algo = RRSI(config=RRSIConfig(rounds=1, max_repairs=0))
        d = algo.step(
            view,
            AlgorithmState(
                data={
                    "phase": "generated",
                    "planned": ["cand"],
                    "parent": "anchor",
                    "failures": ["t"],
                    "round": 0,
                }
            ),
        )
        eval_ops = [op for op in d.operations if op.kind == "evaluate_seed"]
        self.assertEqual(len(eval_ops), 0)
        self.assertEqual(d.operations[0].kind, "stop")


if __name__ == "__main__":
    unittest.main()
