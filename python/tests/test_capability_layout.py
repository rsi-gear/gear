"""Public capability boundaries, compatibility and pre-migration search behavior."""

import importlib
import json
import os
import subprocess
import sys
import unittest
from dataclasses import asdict
from pathlib import Path

from gear.algorithms import GEPA, RandomSearch
from gear.canonical import digest
from gear.core import clone, describe_module, freeze_module
from gear.refine.worker import load_entrypoint, make_algorithm
from gear.search.parents import ScopedFrontier, select_uniform_parent
from gear.search.sampling import GEPASampler, sample_all_tasks
from gear.search.stopping import AnyStop, empty_tasks, evaluation_budget_exhausted, search_complete
from gear.search.testkit import toy_round


class CapabilityLayoutTests(unittest.TestCase):
    def test_foundational_operations_do_not_import_domains_or_sdk(self):
        code = """
import sys
from gear.core import ApplyEdits, ApplyInput, CheckEdits, EditCheckInput, EditPlan, FileContent, FileEdit
value = ApplyInput({}, EditPlan((FileEdit('create', 'prompt.txt', None, FileContent('text')),)))
assert CheckEdits()(EditCheckInput(value)).status == 'allow'
assert ApplyEdits()(value)['prompt.txt'].content == 'text'
assert not any(name.startswith(('gear.algorithms', 'gear.search', 'gear.evaluation', 'gear.memory', 'gear.training', 'gear.refine', 'gear.project')) for name in sys.modules)
"""
        subprocess.run([sys.executable, "-c", code], check=True, env=os.environ.copy())

    def test_capabilities_do_not_load_complete_algorithms(self):
        subprocess.run(
            [
                sys.executable,
                "-c",
                """
import sys
import gear.core, gear.evaluation, gear.memory, gear.search
assert not any(name.startswith(('gear.algorithms', 'gear.project', 'gear.ops')) for name in sys.modules)
assert not hasattr(gear.search, 'GEPA')
assert not hasattr(gear.search, 'RandomSearch')
import gear.training
assert not any(name in sys.modules for name in ('torch', 'slime', 'transformers', 'aiohttp'))
""",
            ],
            check=True,
            env=os.environ.copy(),
        )

    def test_all_legacy_operator_exports_are_the_same_canonical_objects(self):
        from gear import ops

        capabilities = [
            importlib.import_module("gear." + name)
            for name in ("core", "evaluation", "memory", "search")
        ]
        for name in ops.__all__:
            with self.subTest(name=name):
                owners = [module for module in capabilities if name in module.__all__]
                self.assertEqual(len(owners), 1)
                value = getattr(ops, name)
                self.assertIs(value, getattr(owners[0], name))
                self.assertTrue(value.__module__.startswith(owners[0].__name__ + "."))

        from gear.algorithms import contracts
        from gear.search import Decision, contracts_v1

        self.assertIs(contracts.Decision, contracts_v1.Decision)
        self.assertIsNot(Decision, contracts.Decision)
        self.assertIs(ops.Decision, Decision)

    def test_search_components_roundtrip_clone_and_replace_without_changing_original(self):
        from gear.core.base import construct_module
        from gear.project import Project

        algorithm = GEPA(parent_policy=ScopedFrontier(), sampler=GEPASampler(), stop_rule=AnyStop())
        modified = clone(algorithm)
        modified.set_params(parent_policy__batch_count=2, sampler__bridge_ratio=0.75)
        self.assertEqual(algorithm.parent_policy.batch_count, 1)
        self.assertEqual(modified.parent_policy.batch_count, 2)
        self.assertEqual(modified.sampler.bridge_ratio, 0.75)
        description = describe_module(modified).to_dict()
        reconstructed = construct_module(description, load_entrypoint)
        self.assertEqual(describe_module(reconstructed).to_dict(), description)
        admitted = Project._describe_algorithm(modified)
        rebuilt = make_algorithm(admitted["algorithm"])
        self.assertEqual(describe_module(rebuilt).to_dict(), description)
        with self.assertRaisesRegex(ValueError, "frozen"):
            rebuilt.set_params(global_gate="no_regression")
        with self.assertRaisesRegex(ValueError, "frozen"):
            rebuilt.sampler.set_params(bridge_ratio=0.25)
        reconstructed = freeze_module(reconstructed)
        with self.assertRaisesRegex(ValueError, "frozen"):
            reconstructed.set_params(global_gate="no_regression")

    def test_all_six_search_capabilities_have_importable_components(self):
        from gear.core.base import construct_module
        from gear.search.proposal import plan_exploratory_proposals, plan_proposals
        from gear.search.ranking import rank_candidates
        from gear.search.workflow import ScreenedEvaluate, StagedSearch

        components = (
            ScopedFrontier(),
            select_uniform_parent,
            GEPASampler(),
            sample_all_tasks,
            plan_proposals,
            plan_exploratory_proposals,
            rank_candidates,
            AnyStop(),
            StagedSearch(
                select_uniform_parent,
                sample_all_tasks,
                plan_exploratory_proposals,
                rank_candidates,
                AnyStop(),
                ("global",),
                (),
            ),
            ScreenedEvaluate(),
        )
        for component in components:
            with self.subTest(component=type(component).__name__):
                spec = describe_module(component).to_dict()
                self.assertEqual(
                    describe_module(construct_module(spec, load_entrypoint)).to_dict(), spec
                )

    def test_stop_composition_preserves_priority_and_exact_budget_boundary(self):
        from gear.search.contracts_v1 import AlgorithmState, Budget, SearchView, Task

        view = SearchView("run", 0, "seed", (), (), (), (), Budget(-1, 1, 1), "anchor")
        state = AlgorithmState(data={"phase": "done"})
        self.assertEqual(AnyStop()(view, state), "empty seed universe")
        self.assertEqual(AnyStop((search_complete, empty_tasks))(view, state), "search complete")
        from dataclasses import replace

        view = replace(view, tasks=(Task("task", "family"),), budget=Budget(0, 1, 1))
        self.assertIsNone(evaluation_budget_exhausted(view, AlgorithmState()))

    def test_complete_algorithm_traces_match_pre_migration_baseline(self):
        expected = json.loads(
            (Path(__file__).parent / "fixtures/search-capability-traces.json").read_text()
        )
        cases = {
            "gepa-default": GEPA(),
            "random-default": RandomSearch(),
            "gepa-wide": GEPA(
                sampler=GEPASampler(
                    local_ratio=0.5, shared_ratio=0, cross_ratio=0.5, bridge_ratio=1
                )
            ),
            "gepa-mixture": GEPA(
                parent_policy=ScopedFrontier(batch_count=2, champion_probability=0.25)
            ),
            "gepa-gate": GEPA(global_gate="no_regression", promotion_widths=(3, 1)),
        }

        class Recorded:
            def __init__(self, algorithm):
                self.algorithm, self.trace = algorithm, []

            def step(self, view, state):
                result = self.algorithm.step(view, state)
                self.trace.append(
                    {"view": asdict(view), "state": asdict(state), "decision": asdict(result)}
                )
                return result

        for name, algorithm in cases.items():
            with self.subTest(case=name):
                wrapped = Recorded(algorithm)
                outcome = toy_round(wrapped)
                self.assertEqual(
                    {
                        "outcome": outcome,
                        "trace_digest": digest(json.loads(json.dumps(wrapped.trace))),
                    },
                    expected[name],
                )


if __name__ == "__main__":
    unittest.main()
