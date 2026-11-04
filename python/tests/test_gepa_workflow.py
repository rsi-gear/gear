"""Native GEPA decisions retain the established staged search's behavior."""

import unittest
from dataclasses import asdict, replace

from test_seed_gate import configuration, metric

from gear.algorithms import GEPA, AlgorithmState, Budget, Candidate, Evidence, SearchView, Task
from gear.algorithms.contracts import OperationResult
from gear.algorithms.gepa.parents import ScopedFrontier
from gear.algorithms.testkit import wire
from gear.algorithms.workflow import StagedSearch
from gear.canonical import digest
from gear.refine.protocol import validate


def legacy(algorithm):
    return StagedSearch(
        algorithm.parent_policy,
        algorithm.sampler,
        algorithm.proposal_planner,
        algorithm.ranker,
        algorithm.stop_rule,
        algorithm.stages,
        algorithm.promotion_widths,
        algorithm.global_gate,
    )


def advance(view, operations, *, failing=None, score=None, process=False):
    failing = failing or (lambda operation: False)
    for index, operation in enumerate(operations):
        failed = failing(operation)
        result = OperationResult(
            f"{view.step_id}:{index}",
            operation.kind,
            "failed" if failed else "complete",
            operation.candidate_id,
        )
        if operation.kind == "diagnose_seed":
            result = replace(
                result,
                data={
                    "hypotheses": [
                        "Improve correctness.",
                        "Preserve formatting.",
                        "Check calculations.",
                        "Retry safely.",
                    ]
                },
            )
        elif operation.kind == "generate_candidate" and not failed:
            view = replace(
                view,
                candidates=view.candidates
                + (
                    Candidate(
                        operation.candidate_id, digest(operation.candidate_id), operation.parent_id
                    ),
                ),
                budget=replace(
                    view.budget, candidates_remaining=view.budget.candidates_remaining - 1
                ),
            )
        elif operation.kind == "evaluate_seed":
            existing = {(x.candidate_id, x.task_id, x.repetition) for x in view.evidence}
            cells = []
            for task in operation.task_ids:
                for repetition in range(view.budget.repetitions):
                    if (operation.candidate_id, task, repetition) in existing:
                        continue
                    value = (
                        score(operation, task)
                        if score
                        else (0.25 if operation.candidate_id == "anchor" else 0.75)
                    )
                    cells.append(
                        Evidence(
                            operation.candidate_id,
                            task,
                            repetition,
                            value,
                            "scoring_failed" if value is None else "valid",
                            operation.scope,
                            raw_metrics={"process_score": metric("process_score", 0.5)}
                            if process
                            else None,
                        )
                    )
            view = replace(
                view,
                evidence=view.evidence + tuple(cells),
                budget=replace(
                    view.budget,
                    evaluations_remaining=view.budget.evaluations_remaining - len(cells),
                ),
            )
        view = replace(view, completed=view.completed + (result,))
    return replace(view, step_id=view.step_id + 1)


class GepaWorkflowTests(unittest.TestCase):
    def assert_parity(
        self,
        algorithm=None,
        *,
        rounds=2,
        candidates=4,
        task_count=12,
        evaluations=1000,
        failing=None,
        score=None,
        objective=None,
    ):
        algorithm = algorithm or GEPA()
        old = legacy(algorithm)
        state, previous = AlgorithmState(), AlgorithmState()
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
        for _ in range(150):
            actual = algorithm.step(view, state)
            expected = old.step(view, previous)
            validate("Decision", wire(actual))
            self.assertEqual(actual.operations, expected.operations)
            self.assertEqual(actual.reason, expected.reason)
            self.assertEqual(actual.research, expected.research)
            self.assertEqual(actual.state.data["policy_state"], expected.state.data)
            self.assertEqual(wire(actual), wire(algorithm.step(view, state)))
            state, previous = actual.state, expected.state
            if actual.operations[0].kind in ("stop", "nominate"):
                self.assertEqual(state.data["workflow"], 1)
                return actual, view
            view = advance(
                view, actual.operations, failing=failing, score=score, process=objective is not None
            )
        self.fail("GEPA did not finish")

    def test_default_widths_and_multiple_rounds_match_legacy_decisions(self):
        self.assert_parity()

    def test_multi_parent_batches_and_global_gate_match(self):
        self.assert_parity(
            GEPA(
                parent_policy=ScopedFrontier(batch_count=2),
                promotion_widths=(2, 1),
                global_gate="no_regression",
            ),
            candidates=8,
        )

    def test_failed_diagnosis_or_partial_generation_match(self):
        for kind in ("diagnose_seed", "generate_candidate"):
            with self.subTest(kind=kind):
                self.assert_parity(
                    failing=lambda op: (
                        op.kind == kind
                        and (op.kind == "diagnose_seed" or op.candidate_id.endswith("-0"))
                    )
                )

    def test_incomplete_evidence_and_low_budget_match(self):
        self.assert_parity(
            score=lambda op, task: None if op.candidate_id != "anchor" and task == "0" else 0.25
        )
        self.assert_parity(evaluations=12)

    def test_multisignal_champion_and_upper_bound_match(self):
        self.assert_parity(objective=configuration())
        self.assert_parity(
            objective=configuration(ranges=True),
            score=lambda op, task: 1.0 if op.candidate_id != "anchor" else 0.0,
        )

    def test_custom_stop_rule_sees_the_same_phase_state(self):
        def stop(view, state):
            return "operator stop" if state.data.get("phase") == "generated" else None

        self.assert_parity(GEPA(stop_rule=stop))

    def test_existing_phase_journal_keeps_legacy_route(self):
        algorithm = GEPA()
        view = SearchView(
            "legacy",
            0,
            "fixed",
            (Task("a", "a"),),
            (Candidate("anchor", digest("anchor")),),
            (),
            (),
            Budget(10, 1, 1),
            "anchor",
        )
        state = AlgorithmState(data={"phase": "parents", "round": 0})
        self.assertEqual(
            asdict(algorithm.step(view, state)), asdict(legacy(algorithm).step(view, state))
        )


if __name__ == "__main__":
    unittest.main()
