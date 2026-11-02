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
