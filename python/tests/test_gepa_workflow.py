"""Native built-ins preserve the previous search observations and replay safely."""

import inspect
import json
import unittest
from pathlib import Path

from gear.algorithms.testkit import wire
from staged_search_fixture import advance
from test_seed_gate import configuration, metric

from gear.algorithms import GEPA, AlgorithmState, Budget, Candidate, RandomSearch, SearchView, Task
from gear.algorithms.gepa.parents import ScopedFrontier
from gear.canonical import digest
from gear.refine.protocol import validate
from gear.refine.run_context import WorkflowAlgorithm
from gear.refine.worker import decode_view, make_algorithm

REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "staged-search-v1.json").read_text()
)["scenarios"]




class StagedWorkflowTests(unittest.TestCase):
    def assert_reference(
        self,
        name,
        factory=GEPA,
        *,
        rounds=2,
        candidates=4,
        task_count=12,
        evaluations=1000,
        failing=None,
        score=None,
        objective=None,
    ):
        state = AlgorithmState()
        view = SearchView(
            "gepa-parity",
            0,
            "fixed",
            tuple(Task(str(i), str(i % 3)) for i in range(task_count)),
            (Candidate("anchor", digest("anchor")),),
            (),
            (),
            Budget(evaluations, candidates, rounds),
            "anchor",
            objective,
        )
        observations = []
        for _ in range(150):
            # Recreate both the worker's object and its JSON input at every boundary.
            actual = factory().step(view, state)
            validate("Decision", wire(actual))
            restored = factory().step(
                decode_view(wire(view)),
                AlgorithmState(**json.loads(json.dumps(wire(state)))),
            )
            self.assertEqual(wire(actual), wire(restored))
            self.assertEqual(actual.state.data["workflow"], 1)
            value = wire(actual)
            observations.append({
                "operations": value["operations"],
                "reason": actual.reason,
                "research": value["research"],
                "policy_state": actual.state.data["policy_state"],
            })
            state = actual.state
            if actual.operations[0].kind in ("stop", "nominate"):
                expected = REFERENCE[name]
                self.assertEqual(value["operations"], expected["final"])
                self.assertEqual(len(view.evidence), expected["evidence"])
                self.assertEqual(len(observations), expected["decisions"])
                self.assertEqual(digest(observations), expected["digest"])
                return actual, view
            view = advance(
                view, actual.operations, failing=failing, score=score,
                raw_metrics={"process_score": metric("process_score", 0.5)} if objective is not None else None,
            )
        self.fail("native search did not finish")

    def test_gepa_default_widths_and_multiple_rounds_preserve_observations(self):
        self.assert_reference("gepa-default")

    def test_multi_parent_batches_and_global_gate_preserve_observations(self):
        self.assert_reference(
            "gepa-multi-parent",
            lambda: GEPA(
                parent_policy=ScopedFrontier(batch_count=2),
                promotion_widths=(2, 1),
                global_gate="no_regression",
            ),
            candidates=8,
        )

    def test_failed_diagnosis_or_partial_generation_preserve_observations(self):
        for prefix, factory in (("gepa", GEPA), ("random", RandomSearch)):
            for kind, scenario in (
                ("diagnose_seed", "failed-diagnosis"),
                ("generate_candidate", "partial-generation"),
            ):
                with self.subTest(algorithm=prefix, kind=kind):
                    self.assert_reference(
                        f"{prefix}-{scenario}",
                        factory,
                        failing=lambda op: (
                            op.kind == kind
                            and (op.kind == "diagnose_seed" or op.candidate_id.endswith("-0"))
                        ),
                    )

    def test_incomplete_evidence_and_low_budget_preserve_observations(self):
        self.assert_reference(
            "gepa-incomplete-evidence",
            score=lambda op, task: None if op.candidate_id != "anchor" and task == "0" else 0.25,
        )
        self.assert_reference("gepa-low-budget", evaluations=12)
        self.assert_reference("random-low-budget", RandomSearch, evaluations=12)

    def test_multisignal_champion_and_upper_bound_preserve_observations(self):
        self.assert_reference("gepa-multisignal", objective=configuration())
        self.assert_reference(
            "gepa-upper-bound",
            objective=configuration(ranges=True),
            score=lambda op, task: 1.0 if op.candidate_id != "anchor" else 0.0,
        )

    def test_custom_stop_rule_sees_the_same_phase_snapshots(self):
        def stop(view, state):
            return "operator stop" if state.data.get("phase") == "generated" else None

        self.assert_reference("gepa-custom-stop", lambda: GEPA(stop_rule=stop))
        self.assert_reference("random-custom-stop", lambda: RandomSearch(stop_rule=stop))

    def test_random_search_preserves_observations_with_native_checkpoints(self):
        self.assert_reference("random-default", RandomSearch)
        for algorithm in (GEPA(), RandomSearch()):
            with self.subTest(algorithm=type(algorithm).__name__):
                self.assertIsInstance(algorithm, WorkflowAlgorithm)
                self.assertTrue(inspect.iscoroutinefunction(algorithm.run))

    def test_saved_pre_layout_sdk_defaults_execute_unchanged(self):
        descriptions = json.loads(
            (Path(__file__).parent / "fixtures" / "builtin-options-v1.json").read_text()
        )["algorithms"]
        for description in descriptions:
            with self.subTest(algorithm=description["name"]):
                name = "gepa-default" if description["name"] == "gepa" else "random-default"
                self.assert_reference(name, lambda: make_algorithm(description))


if __name__ == "__main__":
    unittest.main()
