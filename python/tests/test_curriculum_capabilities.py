"""TRACE capability statistics require complete, population-bound labeling passes."""

import importlib
import unittest
from dataclasses import replace

from gear.core import clone
from gear.core.base import construct_module
from gear.curriculum import Capability, ContrastCapabilities, ExtractOutcomeCases, OutcomeRecord


def cases():
    return ExtractOutcomeCases()(
        tuple(
            OutcomeRecord(
                "task-" + sample,
                "family",
                sample,
                0,
                "policy",
                "environment",
                "completed",
                passed,
                True,
                "A training request",
                "An observed verdict",
                ({"sample": sample},),
            )
            for sample, passed in (("f1", False), ("f2", False), ("s1", True), ("s2", True))
        )
    )


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.cases = cases()
        self.operator = ContrastCapabilities(minimum_consistent_runs=2)
        self.capabilities = self.operator.parse(
            {
                "capabilities": [
                    {
                        "name": "confirmation",
                        "description": "Obtain informed confirmation before changes.",
                    },
                    {
                        "name": "ambiguous",
                        "description": "A misleading capability absent everywhere.",
                    },
                    {
                        "name": "no-counterexamples",
                        "description": "No applicable successful evidence.",
                    },
                ]
            },
            cases=self.cases,
        )

    def response(self, *, confirmation=True):
        labels = []
        for cap in self.capabilities:
            for case in self.cases:
                if cap.name == "confirmation":
                    label = (
                        "LACKING" if confirmation and case.record.sample_id == "f1" else "PRESENT"
                    )
                elif cap.name == "ambiguous":
                    label = "LACKING"
                else:
                    label = "NA" if case.outcome == "success" else "LACKING"
                labels.append(
                    {
                        "capability_id": cap.capability_id,
                        "case_id": case.case_id,
                        "label": label,
                        "reason": "Explicit test annotation.",
                    }
                )
        return {"labels": labels}

    def parse(self, response=None, run="run-1"):
        return self.operator.parse_labels(
            response or self.response(),
            capabilities=self.capabilities,
            cases=self.cases,
            run_id=run,
        )

    def test_discovery_and_independent_labels_roundtrip_module_parameters(self):
        prepared = self.operator.prepare(self.cases)
        self.assertEqual({row["outcome"] for row in prepared.data["cases"]}, {"success", "failure"})
        first = self.operator.prepare_labels(self.capabilities, cases=self.cases, run_id="first")
        second = self.operator.prepare_labels(self.capabilities, cases=self.cases, run_id="second")
        self.assertEqual(first.data["capabilities"], second.data["capabilities"])
        self.assertNotEqual(first.data["run_id"], second.data["run_id"])
        self.assertNotIn("labels", second.data)

        def resolve(path):
            module, name = path.split(":")
            return getattr(importlib.import_module(module), name)

        self.assertEqual(
            construct_module(self.operator.describe().to_dict(), resolve), self.operator
        )
        self.assertEqual(clone(self.operator), self.operator)
        self.assertNotEqual(
            clone(self.operator).set_params(gap_threshold=0.3).identity, self.operator.identity
        )

    def test_gap_coverage_and_consistency_filter_out_uniformly_missing_capabilities(self):
        runs = (
            self.parse(run="a"),
            self.parse(run="b"),
            self.parse(self.response(confirmation=False), run="c"),
        )
        selected = self.operator.select(self.capabilities, cases=self.cases, labelings=runs)
        target = selected[0]
        self.assertTrue(target.selected)
        self.assertEqual(target.capability.name, "confirmation")
        self.assertEqual(target.passing_runs, 2)
        self.assertAlmostEqual(target.mean_coverage, 1 / 3)
        self.assertAlmostEqual(target.mean_gap, 1 / 3)
        self.assertEqual(target.metrics[0].error_failed, 0.5)
        self.assertEqual(target.metrics[0].error_successful, 0)
        self.assertEqual(target.families, ("family",))
        expected_support = next(
            case.case_id for case in self.cases if case.record.sample_id == "f1"
        )
        self.assertEqual(target.support_case_ids, (expected_support,))
        ambiguous = next(row for row in selected if row.capability.name == "ambiguous")
        self.assertEqual(ambiguous.mean_coverage, 1)
        self.assertEqual(ambiguous.mean_gap, 0)
        self.assertFalse(ambiguous.selected)
        self.assertEqual(
            selected,
            self.operator.select(
                tuple(reversed(self.capabilities)),
                cases=tuple(reversed(self.cases)),
                labelings=tuple(reversed(runs)),
            ),
        )

    def test_empty_applicable_denominator_is_unknown_and_never_a_positive_gap(self):
        result = self.operator.select(
            self.capabilities,
            cases=self.cases,
            labelings=(self.parse(run="a"), self.parse(run="b")),
        )
        absent = next(row for row in result if row.capability.name == "no-counterexamples")
        self.assertEqual(absent.defined_gap_runs, 0)
        self.assertIsNone(absent.mean_gap)
        self.assertIsNone(absent.metrics[0].error_successful)
        self.assertIsNone(absent.metrics[0].gap)
        self.assertFalse(absent.selected)

    def test_complete_matrix_has_no_missing_duplicate_or_fabricated_labels(self):
        for change in ("missing", "duplicate", "case", "capability", "label"):
            response = self.response()
            if change == "missing":
                response["labels"].pop()
            elif change == "duplicate":
                response["labels"][-1] = response["labels"][0]
            else:
                response["labels"][0][
                    {"case": "case_id", "capability": "capability_id", "label": "label"}[change]
                ] = "invented"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.parse(response)

    def test_population_dictionary_and_operator_binding_and_duplicate_votes(self):
        first, second = self.parse(run="a"), self.parse(run="b")
        for runs in (
            (first,),
            (first, first),
            (first, replace(second, cases_digest="changed")),
            (first, replace(second, dictionary_digest="changed")),
            (first, replace(second, labels=second.labels[:-1])),
        ):
            with self.subTest(runs=runs), self.assertRaises(ValueError):
                self.operator.select(self.capabilities, cases=self.cases, labelings=runs)
        with self.assertRaises(ValueError):
            clone(self.operator).set_params(gap_threshold=0.4).select(
                self.capabilities, cases=self.cases, labelings=(first, second)
            )
        with self.assertRaises(ValueError):
            self.operator.prepare_labels(
                (Capability("same", "first"), Capability("same", "second")),
                cases=self.cases,
                run_id="a",
            )

    def test_unknown_private_unreferenced_and_cross_policy_sources_cannot_supply_contrast(self):
        for updates in ({"policy_id": "another"}, {"evidence_refs": ()}, {"partition": "test"}):
            changed = replace(self.cases[0], record=replace(self.cases[0].record, **updates))
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.operator.prepare((changed,) + self.cases[1:])
        unknown = ExtractOutcomeCases()(
            (
                replace(
                    self.cases[0].record,
                    sample_id="unknown",
                    passed=None,
                    complete=False,
                    status="unknown",
                ),
            )
        )[0]
        prepared = self.operator.prepare(self.cases + (unknown,))
        self.assertEqual(len(prepared.data["cases"]), 4)
        with self.assertRaises(ValueError):
            self.operator.prepare(
                tuple(case for case in self.cases if case.outcome == "success") + (unknown,)
            )
        for parameters in (
            {"gap_threshold": float("nan")},
            {"coverage_threshold": 0},
            {"minimum_consistent_runs": True},
            {"max_capabilities": 0},
        ):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                clone(self.operator).set_params(**parameters).prepare(self.cases)


if __name__ == "__main__":
    unittest.main()
