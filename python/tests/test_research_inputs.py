import csv
import json
import tempfile
import unittest
from pathlib import Path

from test_llm_scorer import config

from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.llm_scorer import rubric_request


class ResearchInputTests(unittest.TestCase):
    def test_derived_target_input_preserves_original_llm_judge_instruction_and_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (root / "tasks.csv").open("w") as stream:
                writer = csv.writer(stream)
                writer.writerow(["id", "instruction", "expected", "family", "split"])
                writer.writerow(["one", "Original question", "PRIVATE_REFERENCE", "sample", "seed"])
            benchmark = compile_benchmark(
                root,
                {
                    "version": 1,
                    "source": "tasks.csv",
                    "template": "llm",
                    "scorer": config(),
                    "fixtures": {
                        "one": [{"actual": "correct", "score": 1}, {"actual": "wrong", "score": 0}]
                    },
                },
            )
            result = compile_harbor(
                benchmark,
                str(root / "harbor"),
                ["one"],
                "python@sha256:" + "1" * 64,
                task_inputs={"one": "Reflect on the mistake. Original question"},
            )
            task = Path(result["directory"]) / "one"
            self.assertIn("Reflect on the mistake", (task / "instruction.md").read_text())
            self.assertNotIn("PRIVATE_REFERENCE", (task / "instruction.md").read_text())
            spec = json.loads((task / "tests/expected.json").read_text())
            self.assertEqual(spec["instruction"], "Original question")
            request = json.loads(
                rubric_request(
                    "answer", spec["expected"], spec["rule"]["scorer"], spec["instruction"], {}
                )
            )
            actual_input = json.loads(request["messages"][1]["content"])
            self.assertEqual(actual_input["instruction"], "Original question")
            self.assertEqual(actual_input["expected"], "PRIVATE_REFERENCE")
