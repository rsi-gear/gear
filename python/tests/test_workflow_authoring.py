"""Public async authoring example, configuration capture and explicit toy replies."""

import importlib.util
import sys
import unittest
from pathlib import Path

from gear import Project
from gear.algorithms.testkit import toy_round

EXAMPLE = Path(__file__).resolve().parents[2] / "examples/algorithms/async_workflow.py"
spec = importlib.util.spec_from_file_location("async_workflow_example", EXAMPLE)
example = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = example
spec.loader.exec_module(example)


class WorkflowAuthoringTests(unittest.TestCase):
    def test_example_captures_importable_source_through_project_api(self):
        description = Project._describe_algorithm(example.ReflectAndEdit())
        self.assertEqual(
            description["algorithm"],
            {"name": "async_workflow_example:ReflectAndEdit", "options": {}},
        )
        self.assertEqual(
            description["sources"],
            [{"path": "async_workflow_example.py", "source": str(EXAMPLE)}],
        )

    def test_example_toy_uses_explicit_role_replies_and_real_decision_contract(self):
        roles = []

        def reply(operation):
            roles.append(operation.kind)
            self.assertIn("meta", operation.payload)
            return "Fix arithmetic and preserve the output format."

        result = toy_round(example.ReflectAndEdit(), meta_response=reply)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(roles, ["diagnose_seed", "generate_candidate"])
        self.assertEqual(
            result["operations"],
            [
                "evaluate_seed:global",
                "diagnose_seed:global",
                "generate_candidate:global",
                "evaluate_seed:global",
                "nominate:global",
            ],
        )


if __name__ == "__main__":
    unittest.main()
