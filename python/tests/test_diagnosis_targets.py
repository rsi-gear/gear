"""GEPA diagnoses the tasks a selected objective signal can still improve."""

import unittest
from dataclasses import replace

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    SearchView,
    Task,
)
from gear.canonical import digest

UNIT = (0, 1)


def contract(name, direction="maximize", bounds=UNIT):
    return {
        "id": name,
        "digest": name,
        "unit": "ratio",
        "direction": direction,
        "comparisonPrecision": 1e-9,
        **({"range": {"min": bounds[0], "max": bounds[1]}} if bounds else {}),
    }


def objective(terms, *contracts, process=None):
    configuration = {
        "definition": {
            "terms": [
                {"metric": name, "metricContractDigest": name, "weight": weight, "scale": 1}
                for name, weight in terms
            ],
            "constraints": [],
            "comparisonPrecision": 1e-9,
        },
        "metrics": [contract("pass_rate"), *contracts],
        "protection": [],
    }
    if process is not None:
        configuration["seed_rule"] = {
            "rule": "multisignal-v1",
            "outcome": "pass_rate",
            "process": process,
        }
    return configuration


def default(*contracts):
    return objective([("pass_rate", 1)], *contracts, process=[item["id"] for item in contracts])


def available(name, value):
    return {
        "contractDigest": name,
        "unit": "ratio",
        "status": "available",
        "value": value,
        "evidenceRefs": ["raw"],
    }


def missing(name):
    return {"contractDigest": name, "unit": "ratio", "status": "missing", "evidenceRefs": []}


def cell(task, score, **metrics):
    raw = {"pass_rate": available("pass_rate", int(score == 1))}
    for name, value in metrics.items():
        raw[name] = missing(name) if value is None else available(name, value)
    return Evidence("anchor", task, 0, float(score), "valid", "global", raw_metrics=raw)


def view_of(tasks, evidence, configuration, seed="fixed"):
    return SearchView(
        "targets",
        1,
        seed,
        tasks,
        (Candidate("anchor", digest("anchor")),),
        tuple(evidence),
        (),
        Budget(500, 4, 3),
        "anchor",
        configuration,
    )


TASKS = tuple(Task(name, "family") for name in "abcd")


def diagnosed(evidence, configuration):
    state = AlgorithmState(data={"phase": "parents", "round": 1})
    decision = GEPA().step(view_of(TASKS, evidence, configuration), state)
    operation = decision.operations[0]
    assert operation.kind == "diagnose_seed", decision.reason
    return set(operation.task_ids)


class DiagnosisTargetTests(unittest.TestCase):
    def test_default_objective_diagnoses_only_failures(self):
        evidence = [cell("a", 0), cell("b", 1), cell("c", 1), cell("d", 0)]
        self.assertEqual(diagnosed(evidence, default()), {"a", "d"})

    def test_process_group_keeps_passing_tasks_with_room(self):
        evidence = [
            cell("a", 0, process_score=1),
            cell("b", 1, process_score=0.5),
            cell("c", 1, process_score=1),
            cell("d", 1, process_score=1 - 1e-12),
        ]
        self.assertEqual(diagnosed(evidence, default(contract("process_score"))), {"a", "b"})

    def test_minimized_process_group_has_room_above_its_minimum(self):
        evidence = [
            cell("a", 0, violations=0),
            cell("b", 1, violations=0.3),
            cell("c", 1, violations=0),
            cell("d", 1, violations=0),
        ]
        configuration = default(contract("violations", "minimize"))
        self.assertEqual(diagnosed(evidence, configuration), {"a", "b"})

    def test_missing_signal_evidence_counts_as_room(self):
        evidence = [
            cell("a", 0, process_score=1),
            cell("b", 1, process_score=None),
            cell("c", 1, process_score=1),
            cell("d", 1, process_score=1),
        ]
        self.assertEqual(diagnosed(evidence, default(contract("process_score"))), {"a", "b"})

    def test_unbounded_cost_term_keeps_every_task(self):
        configuration = objective(
            [("pass_rate", 1), ("total_tokens", -0.1)], contract("total_tokens", "minimize", None)
        )
        evidence = [cell(task, 1, total_tokens=100) for task in "abc"] + [
            cell("d", 0, total_tokens=100)
        ]
        self.assertEqual(diagnosed(evidence, configuration), set("abcd"))

    def test_bounded_term_uses_the_helpful_bound_of_its_weight(self):
        configuration = objective(
            [("pass_rate", 1), ("total_tokens", -1)],
            contract("total_tokens", "minimize", (0, 1000)),
        )
        evidence = [
            cell("a", 0, total_tokens=0),
            cell("b", 1, total_tokens=500),
            cell("c", 1, total_tokens=0),
            cell("d", 1, total_tokens=1000),
        ]
        self.assertEqual(diagnosed(evidence, configuration), {"a", "b", "d"})

    def test_zero_weight_terms_are_not_signals(self):
        configuration = objective(
            [("pass_rate", 1), ("total_tokens", 0)], contract("total_tokens", "minimize", None)
        )
        evidence = [cell("a", 0, total_tokens=9)] + [
            cell(task, 1, total_tokens=9) for task in "bcd"
        ]
        self.assertEqual(diagnosed(evidence, configuration), {"a"})

    def test_a_task_with_no_metric_evidence_is_judged_by_its_score(self):
        evidence = [
            Evidence("anchor", task, 0, score, "valid", "global")
            for task, score in zip("abcd", (0.0, 1.0, 1.0, 1.0))
        ]
        self.assertEqual(diagnosed(evidence, default()), {"a"})

    def test_a_batch_with_nothing_to_fix_is_skipped(self):
        evidence = [cell("a", 1), cell("b", 1), cell("c", 0), cell("d", 1)]
        state = AlgorithmState(
            data={
                "phase": "parents",
                "round": 1,
                "parent_reason": "selected",
                "batch_index": 0,
                "batches": [
                    {"parent": "anchor", "tasks": ["a", "b"], "count": 1},
                    {"parent": "anchor", "tasks": ["c", "d"], "count": 1},
                ],
            }
        )
        decision = GEPA()._diagnose(view_of(TASKS, evidence, default()), state)
        self.assertEqual(decision.operations[0].kind, "diagnose_seed")
        self.assertEqual(decision.operations[0].task_ids, ("c",))
        self.assertEqual(decision.state.data["batch_index"], 1)


class LocalScopeTests(unittest.TestCase):
    # Family "d" holds every failure and loses the family tie-break by name.
    tasks = tuple(Task(f"t{index:02d}", "abcd"[index % 4]) for index in range(20))
    failing = {"t03", "t07", "t11"}

    def first_evaluation(self, seed):
        evidence = [cell(task.id, int(task.id not in self.failing)) for task in self.tasks]
        view = view_of(self.tasks, evidence, default(), seed)
        state = AlgorithmState(data={"phase": "parents", "round": 1})
        for _ in range(4):
            decision = GEPA().step(view, state)
            state, completed = decision.state, []
            for index, operation in enumerate(decision.operations):
                if operation.kind == "evaluate_seed":
                    return dict(state.data["sampling"]["buckets"])
                result = OperationResult(
                    f"{view.step_id}:{index}", operation.kind, "complete", operation.candidate_id
                )
                if operation.kind == "diagnose_seed":
                    self.assertEqual(set(operation.task_ids), self.failing)
                    result = replace(result, data={"hypotheses": ["Fix the failures."]})
                else:
                    candidate = Candidate(
                        operation.candidate_id, digest(operation.candidate_id), operation.parent_id
                    )
                    view = replace(view, candidates=view.candidates + (candidate,))
                completed.append(result)
            view = replace(
                view, completed=view.completed + tuple(completed), step_id=view.step_id + 1
            )
        self.fail("GEPA did not reach its first local evaluation")

    def test_failure_slots_hold_real_failures_under_the_default_objective(self):
        for seed in ("s1", "s2", "s3", "s4", "s5"):
            with self.subTest(seed):
                self.assertIn(self.first_evaluation(seed)["local"][0], self.failing)


if __name__ == "__main__":
    unittest.main()
