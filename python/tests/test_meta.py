import copy
import unittest

from gear.algorithms.meta import parse_meta_result, prepare_meta


class MetaTests(unittest.TestCase):
    def setUp(self):
        self.input = {
            "operation": {"kind": "diagnose_seed", "task_ids": ["seed"]},
            "tasks": [{"id": "seed", "instruction": "Write the answer"}],
            "evidence": [{"task_id": "seed", "feedback": "wrong format"}],
            "harness": {},
            "mutationPolicy": {},
        }
        self.result = {
            "summary": "format failure",
            "declined": False,
            "hypotheses": ["Respect the output format"],
            "clusters": [{"task_ids": ["seed"], "hypotheses": ["Write the requested file"]}],
        }

    def parse(self, result):
        return parse_meta_result({"operation": self.input["operation"], "result": result})

    def test_both_operations_preserve_inputs_and_editing_instructions(self):
        for kind, instruction in (
            ("diagnose_seed", "Do not edit the candidate."),
            ("generate_candidate", "Change only the allowed mutation paths."),
        ):
            self.input["operation"]["kind"] = kind
            self.input["experience"] = {"cards": []}
            prepared = prepare_meta(self.input)
            self.assertEqual(prepared["input"], self.input)
            self.assertIn(instruction, prepared["prompt"])
            self.assertEqual(set(prepared["schema"]["required"]), set(self.result))
            self.assertLess(len(prepared["prompt"].encode()), 4096)
        self.input["experience"] = None
        self.assertNotIn("experience", prepare_meta(self.input)["input"])

    def test_valid_results_and_decline_are_preserved(self):
        self.assertEqual(self.parse(self.result), self.result)
        self.result["declined"] = True
        self.assertEqual(self.parse(self.result), self.result)

    def test_pr95_historical_base_choice_is_defined_and_checked_in_python(self):
        self.input["operation"]["payload"] = {
            "base_candidates": [
                {"candidate_id": "anchor", "score": 1},
                {"candidate_id": "older", "score": 0.8},
            ]
        }
        prepared = prepare_meta(self.input)
        self.assertEqual(
            prepared["schema"]["properties"]["base_candidate_id"]["enum"], ["anchor", "older"]
        )
        self.assertIn("even when all tasks passed", prepared["prompt"])
        self.assertNotIn("You do not choose parents", prepared["prompt"])
        result = {**self.result, "base_candidate_id": "older"}
        self.assertEqual(self.parse(result), result)
        for bad in (self.result, {**result, "base_candidate_id": "outside"}):
            with self.assertRaises(ValueError):
                self.parse(bad)
        self.input["operation"]["kind"] = "generate_candidate"
        self.assertNotIn("base_candidate_id", prepare_meta(self.input)["schema"]["properties"])
        with self.assertRaises(ValueError):
            self.parse(result)

    def test_pr95_rejects_malformed_base_offers(self):
        for offered in (
            [],
            {},
            [{"candidate_id": "../private", "score": 1}],
            [{"candidate_id": "anchor", "score": True}],
            [{"candidate_id": "anchor", "score": float("inf")}],
            [{"candidate_id": "anchor", "score": 1}] * 2,
        ):
            self.input["operation"]["payload"] = {"base_candidates": offered}
            with self.subTest(offered=offered), self.assertRaises(ValueError):
                prepare_meta(self.input)

    def test_invalid_results_keep_the_existing_bounds_and_seed_scope(self):
        for change in (
            {"extra": True},
            {"declined": 0},
            {"summary": "😀" * 8193},
            {"hypotheses": [42]},
            {"hypotheses": ["x"] * 257},
            {"clusters": self.result["clusters"] * 257},
            {"clusters": [{"task_ids": ["held-out"], "hypotheses": []}]},
            {"clusters": [{"task_ids": ["seed"], "hypotheses": [], "extra": True}]},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.parse({**self.result, **change})
        for field in self.result:
            result = copy.deepcopy(self.result)
            del result[field]
            with self.subTest(missing=field), self.assertRaises(ValueError):
                self.parse(result)
        self.assertEqual(self.parse({**self.result, "summary": "😀" * 8192})["declined"], False)
