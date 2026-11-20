"""Behavioral contracts for the Meta-Harness Python algorithm."""

import unittest
from types import SimpleNamespace

from gear.algorithms import MetaHarness
from gear.canonical import digest
from gear.core import (
    ArtifactRef,
    CallResult,
    CandidateRef,
    GenerateCandidate,
    Meta,
    Results,
    StateTree,
)
from gear.core._json import json_value
from gear.evaluation import (
    Evaluate,
    EvidenceRecord,
    EvidenceSet,
    EvidenceSetSpec,
    ReadEvidence,
    TaskSamples,
)
from gear.project import Project
from gear.refine.worker import make_algorithm


class MetaHarnessTests(unittest.TestCase):
    def setUp(self):
        self.algorithm = MetaHarness()
        self.anchor = CandidateRef("run", "anchor", digest("anchor source"))
        self.tasks = ("seed-pass", "seed-fail")
        self.view = SimpleNamespace(
            run_id="run",
            anchor=self.anchor,
            candidates=(self.anchor,),
            tasks=tuple(SimpleNamespace(id=task) for task in self.tasks),
            objective=None,
            budget={
                "repetitions": 1,
                "rounds": 2,
                "candidates_remaining": 4,
                "generation_requests_remaining": 8,
            },
            results=Results(),
        )

    def evidence(self, candidate, scores):
        assessments = tuple(
            ArtifactRef("run", "assessment", digest([candidate.candidate_id, task]))
            for task in self.tasks
        )
        records = tuple(
            EvidenceRecord(
                f"{candidate.candidate_id}/{task}",
                "attempt",
                assessment,
                task,
                0,
                score,
                "valid" if score == 1 else "task_failed",
            )
            for assessment, (task, score) in zip(assessments, zip(self.tasks, scores, strict=True), strict=True)
        )
        return EvidenceSet(
            ArtifactRef("run", "evidence_set", digest([candidate.candidate_id, list(scores)])),
            EvidenceSetSpec(
                candidate,
                assessments,
                tuple(TaskSamples(task, (0,)) for task in self.tasks),
                tuple((task, 1 / len(self.tasks)) for task in self.tasks),
                digest(None),
            ),
            records,
            True,
        )

    @staticmethod
    def execution_records(*trajectories):
        return [
            {
                "task_id": f"seed-{index}",
                "status": "valid" if index == 0 else "task_failed",
                "output": None,
                "trajectory": json_value(trajectory),
            }
            for index, trajectory in enumerate(trajectories)
        ]

    def complete(self, decision, value, artifacts=(), executions=()):
        if decision.state.data.get("phase") in ("baseline", "evaluate"):
            value = {**value, "executions": list(executions)}
        self.view.results = Results(
            (CallResult(decision.calls[0].ref, "succeeded", value, artifacts=tuple(artifacts)),)
        )
        return self.algorithm.step(self.view, decision.state)

    def test_first_diagnosis_receives_baseline_and_both_trajectory_outcomes(self):
        baseline = self.evidence(self.anchor, (1, 0))
        success = ArtifactRef(
            "run", "target_trajectory", digest("successful trajectory"), "optimization"
        )
        failure = ArtifactRef(
            "run", "target_trajectory", digest("failed trajectory"), "optimization"
        )
        private = ArtifactRef(
            "run", "target_trajectory", digest("private trajectory"), "evaluation_private"
        )
        unrelated = ArtifactRef("run", "assessment", digest("assessment"), "optimization")
        decision = self.algorithm.step(self.view, StateTree())
        diagnosis = self.complete(
            decision,
            json_value(baseline),
            executions=self.execution_records(success, failure, private, unrelated),
        )

        self.assertEqual(diagnosis.state.data["phase"], "diagnose")
        meta_input = diagnosis.calls[0].effect["input"]
        sources = meta_input["sources"]
        self.assertIn(json_value(self.anchor), sources)
        self.assertIn(json_value(success), sources)
        self.assertIn(json_value(failure), sources)
        self.assertNotIn(json_value(private), sources)
        self.assertNotIn(json_value(unrelated), sources)
        self.assertEqual(meta_input["data"]["baseline_trajectory_capture"], "available")
        baseline_row = meta_input["data"]["evaluated_candidates"][0]
        self.assertEqual(baseline_row["task_results"][0]["status"], "valid")
        self.assertEqual(baseline_row["task_results"][1]["status"], "task_failed")

    def test_execution_reader_excludes_non_seed_safe_trajectory_refs(self):
        visible = ArtifactRef("run", "target_trajectory", digest("visible"), "optimization")
        private = ArtifactRef(
            "run", "target_trajectory", digest("private"), "evaluation_private"
        )
        wrong_kind = ArtifactRef(
            "run", "assessment", digest("assessment"), "optimization"
        )
        refs = self.algorithm._execution_trajectories({
            "executions": self.execution_records(visible, private, wrong_kind)
        })
        self.assertEqual(refs, (visible,))

    def test_missing_baseline_trajectory_is_labeled_explicitly(self):
        baseline_step = self.algorithm.step(self.view, StateTree())
        baseline = self.evidence(self.anchor, (1, 0))
        diagnosis = self.complete(baseline_step, json_value(baseline))
        self.assertEqual(
            diagnosis.calls[0].effect["input"]["data"]["baseline_trajectory_capture"],
            "not_captured",
        )

    def test_proposer_can_reuse_an_older_rejected_candidate_as_the_next_base(self):
        anchor_result = self.algorithm.step(self.view, StateTree())
        baseline = self.evidence(self.anchor, (1, 0))
        baseline_trace = ArtifactRef(
            "run", "target_trajectory", digest("baseline trajectory"), "optimization"
        )
        diagnosis = self.complete(
            anchor_result,
            json_value(baseline),
            executions=self.execution_records(baseline_trace),
        )

        first_generation = self.complete(
            diagnosis,
            {
                "summary": "try an alternate parser strategy",
                "base_candidate_id": "anchor",
                "hypothesis": "Use a parser that preserves quoted fields.",
            },
        )
        self.assertEqual(first_generation.calls[0].effect["input"]["base"]["candidate_id"], "anchor")
        older = CandidateRef("run", "older-rejected", digest("large historical source"))
        first_evaluation = self.complete(
            first_generation,
            {"candidate": json_value(older)},
        )
        self.view.candidates = (self.anchor, older)
        second_diagnosis = self.complete(
            first_evaluation,
            json_value(self.evidence(older, (0, 0))),
            executions=self.execution_records(
                ArtifactRef(
                    "run", "target_trajectory", digest("older successful trajectory"), "optimization"
                ),
                ArtifactRef(
                    "run", "target_trajectory", digest("older failed trajectory"), "optimization"
                ),
            ),
        )

        history = second_diagnosis.calls[0].effect["input"]["data"]
        self.assertIn("older-rejected", history["history_candidate_ids"])
        self.assertEqual(history["baseline_trajectory_capture"], "available")
        offered = {item["candidate_id"] for item in history["eligible_base_candidates"]}
        self.assertIn("older-rejected", offered)
        source_ids = {item.get("candidate_id") for item in second_diagnosis.calls[0].effect["input"]["sources"]}
        self.assertIn("older-rejected", source_ids)
        trajectory_refs = {
            item.get("digest")
            for item in second_diagnosis.calls[0].effect["input"]["sources"]
            if item.get("kind") == "target_trajectory"
        }
        self.assertIn(digest("older successful trajectory"), trajectory_refs)
        self.assertIn(digest("older failed trajectory"), trajectory_refs)
        self.assertIn(digest("baseline trajectory"), trajectory_refs)

        second_generation = self.complete(
            second_diagnosis,
            {
                "summary": "reuse the rejected implementation's useful mechanism",
                "base_candidate_id": "older-rejected",
                "hypothesis": "Extend the older implementation with robust quoting.",
            },
        )
        self.assertEqual(
            second_generation.calls[0].effect["input"]["base"]["candidate_id"],
            "older-rejected",
        )

    def test_evidence_page_keys_include_phase_candidate_and_page(self):
        older = CandidateRef("run", "older", digest("older source"))

        def pages(candidate, phase):
            evidence = self.evidence(candidate, (1, 0))
            initial = self.algorithm._read_evidence(
                StateTree().updated(round=0), evidence, phase, ()
            )
            first_key = initial.calls[0].ref.key
            self.view.results = Results(
                (
                    CallResult(
                        initial.calls[0].ref,
                        "succeeded",
                        {"complete": False, "cursor": "next", "records": []},
                    ),
                )
            )
            continuation = self.algorithm.step(self.view, initial.state)
            return first_key, continuation.calls[0].ref.key

        baseline_keys = pages(self.anchor, "baseline")
        candidate_keys = pages(older, "evaluate")
        self.assertEqual(len(set((*baseline_keys, *candidate_keys))), 4)
        self.assertIn("/baseline/anchor/", baseline_keys[0])
        self.assertIn("/baseline/anchor/", baseline_keys[1])
        self.assertIn("/evaluate/older/", candidate_keys[0])
        self.assertIn("/evaluate/older/", candidate_keys[1])
        self.assertTrue(baseline_keys[0].endswith("/0"))
        self.assertTrue(baseline_keys[1].endswith("/1"))
        self.assertTrue(candidate_keys[0].endswith("/0"))
        self.assertTrue(candidate_keys[1].endswith("/1"))

    def test_declined_proposer_payload_advances_without_generation(self):
        self.view.budget["rounds"] = 1
        baseline_step = self.algorithm.step(self.view, StateTree())
        baseline = self.evidence(self.anchor, (1, 0))
        diagnosis = self.complete(baseline_step, json_value(baseline))
        result = self.complete(diagnosis, None)
        self.assertEqual(result.terminal.kind, "stop")
        self.assertEqual(result.calls, ())

    def test_best_common_seed_score_is_nominated_after_configured_rounds(self):
        baseline_step = self.algorithm.step(self.view, StateTree())
        baseline = self.evidence(self.anchor, (1, 0))
        diagnosis = self.complete(baseline_step, json_value(baseline))
        generation = self.complete(
            diagnosis,
            {
                "summary": "change one general mechanism",
                "base_candidate_id": "anchor",
                "hypothesis": "Improve general parsing.",
            },
        )
        first = CandidateRef("run", "first", digest("first"))
        evaluation = self.complete(generation, {"candidate": json_value(first)})
        self.view.candidates = (self.anchor, first)
        diagnosis2 = self.complete(evaluation, json_value(self.evidence(first, (0, 0))))
        generation2 = self.complete(
            diagnosis2,
            {
                "summary": "keep searching after a regression",
                "base_candidate_id": "first",
                "hypothesis": "Improve the general field handling.",
            },
        )
        second = CandidateRef("run", "second", digest("second"))
        self.view.candidates = (self.anchor, first, second)
        evaluation2 = self.complete(generation2, {"candidate": json_value(second)})
        final = self.complete(evaluation2, json_value(self.evidence(second, (1, 1))))

        self.assertEqual(final.terminal.kind, "nominate")
        self.assertEqual(final.terminal.candidate, second)

    def test_sdk_serialization_and_worker_reconstruction_preserve_operator_options(self):
        algorithm = MetaHarness(
            proposer=Meta("Custom diagnosis", {"type": "object"}, max_tokens=384),
            generator=GenerateCandidate(max_tokens=640),
            evaluator=Evaluate(metrics=("latency",)),
            evidence_reader=ReadEvidence(limit=17),
        )
        description = Project._describe_algorithm(algorithm)
        restored = make_algorithm(description["algorithm"])

        self.assertIsInstance(restored, MetaHarness)
        self.assertEqual(restored.proposer.prompt, "Custom diagnosis")
        self.assertEqual(restored.proposer.max_tokens, 384)
        self.assertEqual(restored.generator.max_tokens, 640)
        self.assertEqual(restored.evaluator.metrics, ("latency",))
        self.assertEqual(restored.evidence_reader.limit, 17)


if __name__ == "__main__":
    unittest.main()
