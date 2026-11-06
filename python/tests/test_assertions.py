"""Independent verifier assertions preserve their per-repetition semantics."""

import unittest
from copy import deepcopy
from dataclasses import asdict

from gear.algorithms.assertions import extract_assertions, project_assertions
from gear.algorithms.contracts import Evidence, RankingInput
from gear.algorithms.evidence import complete_scope_mean
from gear.algorithms.projection import project_candidate


class AssertionPolicies(unittest.TestCase):
    def setUp(self):
        self.contract = {
            "id": "independent",
            "digest": "frozen-schema",
            "source": {"path": "originalResult.independent", "extractor": "assertion-status-v1"},
        }
        self.guard = {
            "task_id": "task",
            "partition": "seed",
            "assertion_id": "independent",
            "rule": "must_pass",
        }

    def input(self, before, after, rule="must_pass"):
        def cell(candidate, status):
            return {
                "candidate_id": candidate,
                "task_id": "task",
                "repetition": 0,
                "score": 1,
                "status": "valid",
                "scope": "global",
                "feedback": "",
                "assertions": []
                if status is None
                else [
                    {
                        "id": "independent",
                        "schemaDigest": "frozen-schema",
                        "status": status,
                        "evidenceRefs": ["original"],
                    }
                ],
            }

        return {
            "task_ids": ["task"],
            "partition": "seed",
            "repetitions": 1,
            "anchor_id": "anchor",
            "candidate_id": "candidate",
            "objective": {
                "assertions": [self.contract],
                "assertion_protection": [{**self.guard, "rule": rule}],
            },
            "evidence": [cell("anchor", before), cell("candidate", after)],
        }

    def test_all_guard_status_combinations(self):
        # Guard contract in None/passed/failed/excluded order.
        matrices = {
            "must_pass": ["UUUU", "UPFF", "UPFF", "UPFF"],
            "no_new_violation": ["UUUU", "UPFP", "UPPP", "UPFP"],
        }
        statuses = (None, "passed", "failed", "excluded")
        for rule in ("must_pass", "no_new_violation"):
            for before in (None, "passed", "failed", "excluded"):
                for after in (None, "passed", "failed", "excluded"):
                    with self.subTest(rule=rule, before=before, after=after):
                        value = self.input(before, after, rule)
                        expected = {"U": "unavailable", "P": "passed", "F": "failed"}[
                            matrices[rule][statuses.index(before)][statuses.index(after)]
                        ]
                        self.assertEqual(project_assertions(value)[0]["status"], expected)

    def test_extraction_never_infers_an_assertion_from_outcome(self):
        for source, expected in [
            ("passed", "passed"),
            ("failed", "failed"),
            ("excluded", "excluded"),
            (None, "missing"),
            (True, "invalid"),
            (1, "invalid"),
        ]:
            value = extract_assertions(
                {
                    "contracts": [self.contract],
                    "trial": {
                        "originalResult": {"independent": source},
                        "scores": {"passed": True},
                    },
                    "certified": True,
                    "evidence_refs": ["source"],
                }
            )[0]
            self.assertEqual(value["status"], expected)
        contract = deepcopy(self.contract)
        contract["source"]["extractor"] = "boolean-v1"
        self.assertEqual(
            extract_assertions(
                {
                    "contracts": [contract],
                    "trial": {"originalResult": {"independent": False}},
                    "certified": True,
                    "evidence_refs": ["source"],
                }
            )[0]["status"],
            "failed",
        )
        self.assertEqual(
            extract_assertions(
                {
                    "contracts": [contract],
                    "trial": {"originalResult": {"independent": True}},
                    "certified": False,
                    "evidence_refs": ["source"],
                }
            )[0]["status"],
            "invalid",
        )

    def test_schema_drift_missing_and_unsupported_are_not_success(self):
        for status in ("missing", "invalid", "unsupported"):
            self.assertEqual(
                project_assertions(self.input("passed", status))[0]["status"], "unavailable"
            )
        value = self.input("passed", "passed")
        value["evidence"][1]["assertions"][0]["schemaDigest"] = "changed"
        with self.assertRaisesRegex(ValueError, "schema mismatch"):
            project_assertions(value)
        value = self.input("passed", "passed")
        value["evidence"][1]["assertions"] *= 2
        with self.assertRaisesRegex(ValueError, "duplicate"):
            project_assertions(value)

    def test_each_repetition_must_pass_and_held_out_guards_stay_out_of_seed(self):
        value = self.input("passed", "passed")
        value["repetitions"] = 2
        value["evidence"] += [{**deepcopy(cell), "repetition": 1} for cell in value["evidence"]]
        value["evidence"][-1]["assertions"][0]["status"] = "failed"
        self.assertEqual(
            [item["status"] for item in project_assertions(value)], ["passed", "failed"]
        )
        value["partition"] = "held_out"
        self.assertEqual(project_assertions(value), [])

    def test_default_seed_ranking_checks_assertions_without_an_explicit_partition(self):
        # RankingInput has a seed-only contract; it intentionally has no partition field.
        value = self.input("passed", "failed")
        value["objective"].update(
            {
                "metrics": [
                    {
                        "id": "pass_rate",
                        "digest": "pass-schema",
                        "unit": "ratio",
                        "granularity": "trial",
                        "repetitionReducer": "mean",
                        "taskReducer": "weighted-mean",
                        "direction": "maximize",
                        "comparisonPrecision": 1e-9,
                    }
                ],
                "definition": {
                    "schemaVersion": 1,
                    "digest": "objective",
                    "direction": "maximize",
                    "terms": [
                        {
                            "metric": "pass_rate",
                            "weight": 1,
                            "scale": 1,
                            "metricContractDigest": "pass-schema",
                        }
                    ],
                    "constraints": [],
                    "scorerVersion": "linear-raw-v1",
                    "comparisonPrecision": 1e-9,
                },
                "protection": [],
            }
        )
        ranking = RankingInput(
            ("anchor", "candidate"),
            ("task",),
            tuple(Evidence(**cell) for cell in value["evidence"]),
            1,
            objective=value["objective"],
            anchor_id="anchor",
        )
        plan = complete_scope_mean(ranking)
        self.assertIn("candidate", plan.disqualified)
        self.assertEqual(
            project_candidate({**value, "evidence": [asdict(cell) for cell in ranking.evidence]})[
                "assertion_protection"
            ][0]["status"],
            "failed",
        )
