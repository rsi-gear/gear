import unittest
from dataclasses import asdict, replace

from gear.algorithms.contracts import Evidence, ParentInput, ParentOption, RankingInput
from gear.algorithms.evidence import complete_scope_mean, task_scores
from gear.algorithms.gepa.parents import frontier_options
from gear.algorithms.objective import aggregate_metrics
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
    def project(self, view, candidate):
        return project_candidate(
            {
                "evidence": [asdict(item) for item in view.evidence],
                "task_ids": list(view.task_ids),
                "repetitions": view.repetitions,
                "candidate_id": candidate,
                "anchor_id": view.anchor_id,
                "objective": view.objective,
            }
        )

    def test_duplicate_candidate_does_not_abort_ranking_or_hide_valid_zero(self):
        for objective in (None, configuration()):
            for duplicate_value in (90, 20):
                with self.subTest(objective=bool(objective), duplicate_value=duplicate_value):
                    view = RankingInput(
                        ("anchor", "duplicate"),
                        ("a",),
                        (
                            replace(cell("anchor", 0), score=0),
                            cell("duplicate", 90),
                            cell("duplicate", duplicate_value),
                        ),
                        1,
                        objective=objective,
                        anchor_id="anchor",
                    )
                    ranking = complete_scope_mean(view)
                    self.assertEqual(ranking.candidate_ids, ("anchor",))
                    self.assertEqual(ranking.scores, (("anchor", 0.0),))
                    self.assertEqual(ranking.incomplete, ("duplicate",))
                    self.assertEqual(task_scores(view), {"anchor": (("a", 0.0),)})

    def test_duplicate_anchor_does_not_block_an_independent_objective(self):
        view = RankingInput(
            ("anchor", "better"),
            ("a",),
            (cell("anchor", 10), cell("anchor", 20), cell("better", 90)),
            1,
            objective=configuration(),
            anchor_id="anchor",
        )
        ranking = complete_scope_mean(view)
        self.assertEqual(ranking.candidate_ids, ("better",))
        self.assertEqual(ranking.incomplete, ("anchor",))
        self.assertEqual(task_scores(view), {"better": (("a", 0.9),)})
        result = self.project(view, "anchor")
        self.assertEqual((result["observed"], result["expected"]), (2, 1))
        self.assertFalse(result["complete"])
        self.assertFalse(result["constraints_passed"])
        self.assertIsNone(result["score"])
        for metric in result["metrics"].values():
            self.assertEqual(metric["status"], "invalid")
            self.assertNotIn("value", metric)
            self.assertIn("duplicate", metric["reason"])
            self.assertTrue(metric["evidenceRefs"])

    def test_duplicate_anchor_makes_dependent_protection_unavailable(self):
        for protection in ("constraint", "task", "no_new_violation", "assertion"):
            for reverse in (False, True):
                with self.subTest(protection=protection, reverse=reverse):
                    objective = configuration()
                    if protection == "constraint":
                        objective["definition"]["constraints"] = [
                            {
                                "metric": "quality",
                                "metricContractDigest": "quality-contract",
                                "digest": "guard",
                                "rule": "no_regression",
                                "direction": "maximize",
                                "comparisonPrecision": 1e-9,
                            }
                        ]
                    elif protection in ("task", "no_new_violation"):
                        objective["protection"] = [
                            {
                                "task_id": "a",
                                "partition": "seed",
                                "metric": "quality" if protection == "task" else "pass_rate",
                                "rule": "no_regression" if protection == "task" else protection,
                            }
                        ]
                    else:
                        objective["assertions"] = [{"id": "safe", "digest": "safe-schema"}]
                        objective["assertion_protection"] = [
                            {
                                "task_id": "a",
                                "partition": "seed",
                                "assertion_id": "safe",
                                "rule": "no_new_violation",
                            }
                        ]

                    def guarded(candidate, value, status):
                        return replace(
                            cell(candidate, value),
                            assertions=(
                                {
                                    "id": "safe",
                                    "schemaDigest": "safe-schema",
                                    "status": status,
                                    "evidenceRefs": ["original"],
                                },
                            ),
                        )

                    evidence = (
                        guarded("anchor", 10, "passed"),
                        guarded("anchor", 20, "failed"),
                        guarded("better", 90, "passed"),
                    )
                    view = RankingInput(
                        ("anchor", "better"),
                        ("a",),
                        evidence[::-1] if reverse else evidence,
                        1,
                        objective=objective,
                        anchor_id="anchor",
                    )
                    result = self.project(view, "better")
                    self.assertFalse(result["complete"])
                    self.assertFalse(result["constraints_passed"])
                    outcomes = (
                        result["objective"]["constraintResults"]
                        if protection == "constraint"
                        else result["protection"]
                        if protection in ("task", "no_new_violation")
                        else result["assertion_protection"]
                    )
                    self.assertEqual(outcomes[0]["status"], "unavailable")
                    self.assertEqual(complete_scope_mean(view).candidate_ids, ())
                    self.assertEqual(task_scores(view), {})

    def test_duplicate_anchor_does_not_block_absolute_minimum_protection(self):
        for protection in ("constraint", "task"):
            with self.subTest(protection=protection):
                objective = configuration()
                guard = {"metric": "quality", "rule": "minimum", "value": 50}
                if protection == "constraint":
                    objective["definition"]["constraints"] = [
                        {
                            **guard,
                            "metricContractDigest": "quality-contract",
                            "digest": "guard",
                            "direction": "maximize",
                            "comparisonPrecision": 1e-9,
                        }
                    ]
                else:
                    objective["protection"] = [{**guard, "task_id": "a", "partition": "seed"}]
                view = RankingInput(
                    ("anchor", "better"),
                    ("a",),
                    (cell("anchor", 10), cell("anchor", 20), cell("better", 90)),
                    1,
                    objective=objective,
                    anchor_id="anchor",
                )
                result = self.project(view, "better")
                self.assertTrue(result["complete"])
                self.assertTrue(result["constraints_passed"])
                self.assertEqual(complete_scope_mean(view).candidate_ids, ("better",))

    def test_missing_evidence_retains_metric_diagnostics(self):
        view = RankingInput(
            ("anchor",),
            ("a",),
            (cell("anchor", 10),),
            2,
            objective=configuration(),
            anchor_id="anchor",
        )
        result = self.project(view, "anchor")
        self.assertFalse(result["complete"])
        self.assertIsNone(result["score"])
        self.assertEqual(result["metrics"]["quality"]["status"], "missing")
        self.assertTrue(result["metrics"]["quality"]["evidenceRefs"])

    def test_duplicate_evidence_outside_the_frozen_scope_is_ignored(self):
        outside = replace(cell("anchor", 20), task_id="outside")
        other = cell("other", 20)
        view = RankingInput(
            ("anchor",),
            ("a",),
            (cell("anchor", 10), outside, outside, other, other),
            1,
            objective=configuration(),
            anchor_id="anchor",
        )
        self.assertEqual(complete_scope_mean(view).scores, (("anchor", 0.1),))
        self.assertEqual(task_scores(view), {"anchor": (("a", 0.1),)})

    def test_raw_metric_contract_errors_and_duplicate_aggregation_stay_strict(self):
        for field, value, message in (
            ("contractDigest", "changed", "contract changed"),
            ("unit", "changed", "unit changed"),
            ("value", "not-a-number", "invalid available raw value"),
        ):
            with self.subTest(field=field):
                evidence = cell("anchor", 10)
                evidence.raw_metrics["quality"][field] = value
                view = RankingInput(
                    ("anchor",),
                    ("a",),
                    (evidence,),
                    1,
                    objective=configuration(),
                    anchor_id="anchor",
                )
                with self.assertRaisesRegex(ValueError, message):
                    complete_scope_mean(view)
        record = {"taskId": "a", "repetition": 0, "metrics": {}, "digest": "record"}
        with self.assertRaisesRegex(ValueError, "duplicate raw metric slot"):
            aggregate_metrics(
                {
                    "contracts": configuration()["metrics"],
                    "tasks": [{"id": "a", "repetitions": [0], "weight": 1}],
                    "records": [record, record],
                }
            )

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
