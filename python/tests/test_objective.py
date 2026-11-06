import unittest

from gear.algorithms.contracts import Evidence, ParentInput, ParentOption, RankingInput
from gear.algorithms.evidence import complete_scope_mean, task_scores
from gear.algorithms.gepa.parents import frontier_options
from gear.algorithms.projection import project_candidate


def configuration():
    return {
        "definition": {
            "terms": [
                {
                    "metric": "quality",
                    "metricContractDigest": "quality-contract",
                    "weight": 1,
                    "scale": 100,
                }
            ],
            "constraints": [],
            "comparisonPrecision": 1e-9,
        },
        "metrics": [
            {"id": "pass_rate", "digest": "pass-contract", "unit": "ratio"},
            {
                "id": "quality",
                "digest": "quality-contract",
                "unit": "points",
                "direction": "maximize",
                "comparisonPrecision": 1e-9,
            },
        ],
        "protection": [],
    }


def cell(candidate, value):
    return Evidence(
        candidate,
        "a",
        0,
        1,
        "valid",
        "global",
        raw_metrics={
            "quality": {
                "contractDigest": "quality-contract",
                "unit": "points",
                "status": "available",
                "value": value,
                "evidenceRefs": ["raw"],
            }
        },
    )


class ObjectiveTests(unittest.TestCase):
    def test_frontier_uses_task_objective_even_when_correctness_ties(self):
        view = RankingInput(
            ("anchor", "better"),
            ("a",),
            (cell("anchor", 10), cell("better", 90)),
            1,
            objective=configuration(),
            anchor_id="anchor",
        )
        ranking, profiles = complete_scope_mean(view), task_scores(view)
        self.assertEqual(ranking.candidate_ids, ("better", "anchor"))
        self.assertEqual(profiles, {"anchor": (("a", 0.1),), "better": (("a", 0.9),)})
        parents = ParentInput(
            tuple(
                ParentOption(
                    candidate,
                    "global",
                    ("a",),
                    score,
                    task_scores=profiles[candidate],
                    weights=(("a", 1.0),),
                )
                for candidate, score in ranking.scores
            ),
            1,
            "anchor",
        )
        options = frontier_options(parents)
        self.assertEqual(
            next(item for item in options if item.candidate_id == "better").probability, 1
        )

    def test_champion_mixture_uses_comparable_constrained_objective_gains(self):
        from dataclasses import replace

        from gear.algorithms import GEPA, AlgorithmState, Budget, Candidate, SearchView, Task
        from gear.algorithms.gepa.parents import ScopedFrontier
        from gear.canonical import digest

        seen = []

        def policy(view, rng):
            seen.append(view.champion_id)
            return ScopedFrontier(champion_probability=1)(view, rng)

        protected = configuration()
        protected["metrics"][0].update(direction="maximize", comparisonPrecision=1e-9)
        protected["protection"] = [
            {
                "partition": "seed",
                "task_id": "a",
                "metric": "pass_rate",
                "rule": "minimum",
                "value": 1,
            }
        ]
        violating = replace(cell("leader", 90), score=0)
        cases = [
            ("gain", configuration(), (cell("anchor", 10), cell("leader", 90)), "leader"),
            (
                "below precision",
                configuration(),
                (cell("anchor", 10), cell("leader", 10 + 1e-12)),
                "anchor",
            ),
            # Satisfying the constraints outranks a higher score, as in the ranker.
            (
                "repairs protection",
                protected,
                (replace(cell("anchor", 90), score=0), cell("leader", 50)),
                "leader",
            ),
            ("violates protection", protected, (cell("anchor", 50), violating), "anchor"),
            (
                "skips a disqualified leader",
                protected,
                (cell("anchor", 50), violating, cell("runner", 70)),
                "runner",
            ),
        ]
        for name, objective, cells, champion in cases:
            with self.subTest(name):
                view = SearchView(
                    "objective",
                    1,
                    "fixed",
                    (Task("a", "a"),),
                    tuple(
                        Candidate(
                            item.candidate_id,
                            digest(item.candidate_id),
                            None if item.candidate_id == "anchor" else "anchor",
                        )
                        for item in cells
                    ),
                    cells,
                    (),
                    Budget(100, 2, 2),
                    "anchor",
                    objective,
                )
                state = AlgorithmState(data={"phase": "parents", "round": 0})
                decision = GEPA(parent_policy=policy).step(view, state)
                self.assertEqual(seen[-1], champion)
                self.assertEqual(decision.operations[0].candidate_id, champion)

    def test_missing_protected_metric_is_incomplete_even_if_not_weighted(self):
        objective = configuration()
        objective["definition"]["terms"] = [
            {
                "metric": "pass_rate",
                "metricContractDigest": "pass-contract",
                "weight": 1,
                "scale": 1,
            }
        ]
        objective["protection"] = [
            {
                "partition": "seed",
                "task_id": "a",
                "metric": "quality",
                "rule": "minimum",
                "value": 1,
            }
        ]
        result = project_candidate(
            {
                "evidence": [
                    {
                        "candidate_id": "anchor",
                        "task_id": "a",
                        "repetition": 0,
                        "score": 1,
                        "status": "valid",
                    }
                ],
                "task_ids": ["a"],
                "candidate_id": "anchor",
                "anchor_id": "anchor",
                "repetitions": 1,
                "objective": objective,
            }
        )
        self.assertEqual(result["score"], 1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["protection"][0]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
