"""Resume invariants of the packaged algorithm implementations."""

import unittest
from dataclasses import replace
from types import SimpleNamespace

from gear.algorithms import ACE, OPRO, RRSI, DarwinX, Harness2
from gear.canonical import digest
from gear.core import ArtifactRef, CallRef, CallResult, CandidateRef, Results, StateTree
from gear.core._json import json_value
from gear.evaluation import EvidenceRecord, EvidenceSet, EvidenceSetSpec, TaskSamples


class BuiltinAlgorithmTests(unittest.TestCase):
    def prompt_comparison(self, parent_quality, child_quality, parent_status="complete"):
        objective = {
            "definition": {
                "terms": [
                    {
                        "metric": "quality",
                        "metricContractDigest": "quality-v1",
                        "weight": 1,
                        "scale": 1,
                    }
                ],
                "constraints": [
                    {
                        "metric": "quality",
                        "metricContractDigest": "quality-v1",
                        "digest": "minimum-quality",
                        "rule": "minimum",
                        "value": 0.5,
                        "direction": "maximize",
                        "comparisonPrecision": 1e-9,
                    }
                ],
                "comparisonPrecision": 1e-9,
            },
            "metrics": [{"id": "quality", "digest": "quality-v1", "unit": "points"}],
        }

        def evidence(name, quality):
            candidate = CandidateRef("run", name, digest(name))
            assessment = ArtifactRef("run", "assessment", digest([name, "assessment"]))
            spec = EvidenceSetSpec(
                candidate,
                (assessment,),
                (TaskSamples("task", (0,)),),
                (("task", 1),),
                digest(objective),
            )
            record = EvidenceRecord(
                name + "/sample",
                "attempt",
                assessment,
                "task",
                0,
                1,
                "valid",
                {
                    "quality": {
                        "contractDigest": "quality-v1",
                        "unit": "points",
                        "status": "available",
                        "value": quality,
                        "evidenceRefs": [assessment.digest],
                    }
                },
            )
            return EvidenceSet(
                ArtifactRef("run", "evidence_set", digest([name, "evidence"])),
                spec,
                (record,),
                True,
            )

        parent, child = evidence("anchor", parent_quality), evidence("child", child_quality)
        if parent_status == "unloaded":
            parent = replace(parent, loaded=False)
        elif parent_status == "incomplete":
            parent = replace(parent, records=(replace(parent.records[0], score=None),))
        view = SimpleNamespace(
            anchor=parent.spec.candidate,
            objective=objective,
            tasks=(SimpleNamespace(id="task"),),
            budget={"repetitions": 1, "rounds": 1, "candidates_remaining": 9},
        )
        state = StateTree(
            {
                "anchor_evidence": json_value(parent),
                "current_evidence": json_value(parent),
                "candidate": child.spec.candidate,
                "current": parent.spec.candidate,
                "round": 0,
                "history": [],
            }
        )
        return view, state, json_value(child)

    def test_eligible_child_replaces_constraint_failing_parent(self):
        for implementation in (OPRO, ACE, RRSI, DarwinX):
            with self.subTest(algorithm=implementation.__name__):
                view, state, child = self.prompt_comparison(0.2, 0.8)
                algorithm = implementation()
                result = algorithm._compare(view, state.data, child)
                self.assertEqual(result.ineligible, ("anchor",))
                decision = algorithm._finish_round(view, state, child, result, "comparison")
                self.assertTrue(decision.records[0]["accepted"])
                self.assertEqual(decision.terminal.kind, "nominate")
                self.assertEqual(decision.terminal.candidate.candidate_id, "child")

    def test_constraints_do_not_admit_ineligible_or_unverified_replacements(self):
        for parent, child, status in (
            (0.8, 0.2, "complete"),
            (0.2, 0.3, "complete"),
            (0.8, 0.7, "complete"),
            (0.8, 0.8, "complete"),
            (0.2, 0.8, "unloaded"),
            (0.2, 0.8, "incomplete"),
        ):
            with self.subTest(parent=parent, child=child, status=status):
                view, state, evidence = self.prompt_comparison(parent, child, status)
                algorithm = OPRO()
                result = algorithm._compare(view, state.data, evidence)
                decision = algorithm._finish_round(view, state, evidence, result, "comparison")
                self.assertFalse(decision.records[0]["accepted"])
                self.assertEqual(decision.terminal.kind, "stop")
                self.assertEqual(decision.state.data["current"]["candidate_id"], "anchor")

    def harness_rollout(self, status, trajectory):
        anchor = CandidateRef("run", "anchor", digest("anchor"))
        pending = CallRef("task/round-0/rollout", digest("rollout"))
        output = {
            "sample_id": "sample",
            "attempt_id": "attempt",
            "task_id": "task",
            "status": status,
            "output": json_value(ArtifactRef("run", "task_output", digest("output"))),
            "trajectory": json_value(trajectory),
        }
        receipt = CallResult(
            pending, "succeeded", {"records": [output], "loaded": True, "cursor": None}
        )
        view = SimpleNamespace(
            anchor=anchor,
            objective=None,
            stream={"complete": False, "current_task": "task"},
            tasks=(SimpleNamespace(id="task"),),
            results=Results((receipt,)),
        )
        state = StateTree(
            {
                "phase": "rollout",
                "pending": pending,
                "round": 0,
                "current_prompt": "prompt",
                "base_prompt": "prompt",
            }
        )
        return view, state, output

    def test_harness_reflects_on_output_when_trajectory_is_unavailable(self):
        for status in ("succeeded", "failed", "timed_out", "cancelled"):
            with self.subTest(status=status):
                view, state, output = self.harness_rollout(status, None)
                algorithm = Harness2()
                decision = algorithm.step(view, state)
                self.assertEqual(decision.to_dict(), algorithm.step(view, state).to_dict())
                self.assertEqual(decision.state.data["selected"], output)
                call = decision.calls[0]
                self.assertEqual(call.effect["input"]["sources"], [output["output"]])
                self.assertEqual(decision.state.data["phase"], "reflect")
                view.results = Results((CallResult(call.ref, "succeeded", {"text": "learned"}),))
                committed = algorithm.step(view, decision.state)
                self.assertEqual(committed.state.data["phase"], "commit")

    def test_harness_preserves_available_trajectory(self):
        trajectory = ArtifactRef("run", "target_trajectory", digest("trajectory"))
        view, state, output = self.harness_rollout("succeeded", trajectory)
        decision = Harness2().step(view, state)
        self.assertEqual(
            decision.calls[0].effect["input"]["sources"],
            [output["output"], output["trajectory"]],
        )

    def test_harness_stops_explicitly_when_target_execution_is_unavailable(self):
        view, state, _ = self.harness_rollout("unavailable", None)
        decision = Harness2().step(view, state)
        self.assertEqual(decision.calls, ())
        self.assertEqual(decision.state, state)
        self.assertEqual(decision.terminal.kind, "stop")
        self.assertEqual(decision.terminal.outcome["status"], "failed")
        self.assertEqual(decision.terminal.outcome["execution_status"], "unavailable")
        self.assertEqual(decision.terminal.outcome["sample_id"], "sample")

    def test_confirmation_evidence_pages_have_distinct_resumable_calls(self):
        algorithm = DarwinX()
        first_pages, next_pages = [], []
        for candidate_id in ("anchor", "proposal"):
            candidate = CandidateRef("run", candidate_id, digest(candidate_id))
            evidence = EvidenceSet(
                ArtifactRef("run", "evidence_set", digest([candidate_id, "evidence"])),
                EvidenceSetSpec(
                    candidate,
                    (ArtifactRef("run", "assessment", digest(candidate_id)),),
                    (TaskSamples("task", (0,)),),
                    (("task", 1),),
                    digest("objective"),
                ),
                (),
                False,
            )
            pending = CallRef("confirm/" + candidate_id, digest(candidate_id))
            view = SimpleNamespace(
                results=Results((CallResult(pending, "succeeded", json_value(evidence)),))
            )
            state = StateTree({"phase": "confirm", "round": 0, "pending": pending})
            decision = algorithm.step(view, state)
            self.assertEqual(decision.to_dict(), algorithm.step(view, state).to_dict())
            call = decision.calls[0]
            first_pages.append(call)
            page = {"complete": False, "cursor": "next-page"}
            reading = SimpleNamespace(results=Results((CallResult(call.ref, "succeeded", page),)))
            next_decision = algorithm.step(reading, decision.state)
            next_pages.append(next_decision.calls[0])
            self.assertEqual(
                next_decision.to_dict(), algorithm.step(reading, decision.state).to_dict()
            )
        self.assertEqual(len({call.key for call in (*first_pages, *next_pages)}), 4)
        for first, following in zip(first_pages, next_pages):
            self.assertEqual(first.effect["input"]["ref"], following.effect["input"]["ref"])
            self.assertEqual(following.effect["input"]["cursor"], "next-page")


if __name__ == "__main__":
    unittest.main()
