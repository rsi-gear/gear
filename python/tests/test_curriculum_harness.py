"""Offline checks for the pinned IFEval verifier and paired comparisons."""

import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "examples/curriculum-harness"))
import ifeval as example  # noqa: E402


def rows(values):
    return [{"task": {"id": str(index)}, "passed": value} for index, value in enumerate(values)]


class ComparisonTests(unittest.TestCase):
    def test_exact_ending_is_delimited_without_changing_frozen_verifier_arguments(self):
        class Instruction:
            def __init__(self, name):
                self.kwargs = None

            def build_description(self, **kwargs):
                self.kwargs = kwargs
                return "Finish with " + kwargs["end_phrase"] + "."

            def get_instruction_args(self):
                return self.kwargs

        benchmark = example.Benchmark.__new__(example.Benchmark)
        benchmark.registry = {"startend:end_checker": Instruction}
        for phrase in ("Yes Mom, I am Dave.", 'She said "yes".', "line one\nline two."):
            task = {
                "instruction_id_list": ["startend:end_checker"],
                "kwargs": [{"end_phrase": phrase}],
            }
            rendered = benchmark.descriptions(task)[0]
            literal = rendered.split("this JSON string: ", 1)[1].split("\nDo not", 1)[0]
            self.assertEqual(json.loads(literal), phrase)
            self.assertEqual(task["kwargs"][0]["end_phrase"], phrase)

    def test_calibration_controls_can_violate_the_actual_letter_ceiling(self):
        task = {
            "instruction_id_list": ["keywords:letter_frequency"],
            "kwargs": [{"letter": "i", "let_frequency": 3, "let_relation": "less than"}],
        }
        controls = example.negative_controls(task, "hello world")

        def accepts(text):
            return bool(text.strip()) and text.lower().count("i") < 3

        self.assertTrue(all(accepts(text) for text in controls[1:5]))
        self.assertTrue(any(not accepts(text) for text in controls[5:]))
        self.assertEqual(controls, example.negative_controls(task, "hello world"))
        task["kwargs"][0].update(letter="a", let_relation="at least")
        controls = example.negative_controls(task, "aaa")
        self.assertTrue(any(text and text.count("a") < 3 for text in controls[1:]))

    def test_paired_test_counts_repairs_and_regressions(self):
        result = example.paired_comparison(
            rows([True, False, True, False]), rows([False, True, False, False])
        )
        self.assertEqual((result["wins"], result["losses"]), (2, 1))
        self.assertEqual(result["difference"], 0.25)
        self.assertEqual(result["mcnemar_exact_p"], 1.0)
        self.assertLessEqual(result["paired_bootstrap_95_ci"][0], 0)

    def test_identical_and_all_discordant_results_have_known_exact_statistics(self):
        identical = example.paired_comparison(rows([True, False]), rows([True, False]))
        self.assertEqual(identical["paired_bootstrap_95_ci"], [0, 0])
        self.assertEqual(identical["mcnemar_exact_p"], 1.0)
        all_wins = example.paired_comparison(rows([True] * 6), rows([False] * 6))
        self.assertEqual(all_wins["mcnemar_exact_p"], 0.03125)
        self.assertEqual(all_wins["difference"], 1.0)

    def test_misaligned_test_tasks_are_rejected(self):
        with self.assertRaises(ValueError):
            example.paired_comparison(rows([True, False]), list(reversed(rows([True, False]))))

    def test_repeated_instruction_ids_retain_each_verdict(self):
        benchmark = example.Benchmark.__new__(example.Benchmark)
        benchmark.language_factory = types.SimpleNamespace(seed=None)
        benchmark.verifier_policy = {"language_detection_seed": 0}
        benchmark.descriptions = lambda task: []
        benchmark.evaluation = types.SimpleNamespace(
            InputExample=lambda *args: args,
            test_instruction_following_strict=lambda *args: types.SimpleNamespace(
                follow_all_instructions=False,
                instruction_id_list=["same", "same"],
                follow_instruction_list=[True, False],
            ),
        )
        task = {
            "key": 1,
            "prompt": "example",
            "instruction_id_list": ["same", "same"],
            "kwargs": [{}, {}],
        }
        self.assertEqual(
            benchmark.grade(task, "answer"),
            {
                "passed": False,
                "checks": {"0:same": True, "1:same": False},
            },
        )
        self.assertEqual(benchmark.language_factory.seed, 0)
        benchmark.language_factory.seed = 99
        benchmark.grade(task, "answer")
        self.assertEqual(benchmark.language_factory.seed, 0)


if __name__ == "__main__":
    unittest.main()
