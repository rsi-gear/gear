"""Scope separation, constraint repair and resume invariants of formal prompt search."""

import base64
import hashlib
import json
import unittest
from types import SimpleNamespace

from gear.algorithms.reflective_search import ReflectiveSearch
from gear.canonical import digest
from gear.core import (
    ArtifactRef,
    CallRef,
    CallResult,
    CandidateRef,
    FileContent,
    Results,
    StateTree,
    clone,
)
from gear.core._json import json_value
from gear.core.testing import check_operator
from gear.evaluation import EvidenceRecord, EvidenceSet, EvidenceSetSpec, TaskSamples
from gear.search.constraints import PromptConstraints


class ReflectiveSearchTests(unittest.TestCase):
    def setUp(self):
        self.algorithm = ReflectiveSearch(
            ("train",),
            ("dev",),
            target_characters=20,
            constraints=PromptConstraints(40),
            max_repairs=1,
            nominate=False,
        )
        self.anchor = CandidateRef("run", "anchor", digest("anchor"))
        self.view = SimpleNamespace(
            tasks=(SimpleNamespace(id="train"), SimpleNamespace(id="dev")),
            budget={"repetitions": 1, "rounds": 1, "candidates_remaining": 2},
            anchor=self.anchor,
            objective=None,
            results=Results(()),
        )

    def evidence(self, task="train", *, status="valid", score=0.0):
        assessment = ArtifactRef("run", "assessment", digest([task, "assessment"]))
        return json_value(
            EvidenceSet(
                ArtifactRef("run", "evidence_set", digest([task, "evidence"])),
                EvidenceSetSpec(
                    self.anchor,
                    (assessment,),
                    (TaskSamples(task, (0,)),),
                    ((task, 1.0),),
                    digest(None),
                ),
                (EvidenceRecord(task + "-sample", "attempt", assessment, task, 0, score, status),),
                True,
            )
        )

    def state(self, **extra):
        return StateTree(
            {
                "current": self.anchor,
                "round": 0,
                "learning_repetitions": 1,
                "history": [],
                "proposal_attempt": 0,
                "before": FileContent("initial"),
                "current_evidence": self.evidence("dev"),
                "anchor_evidence": self.evidence("dev"),
                "training_evidence": self.evidence(),
                **extra,
            }
        )

    def test_constraints_are_pure_and_do_not_silently_truncate(self):
        constraints = PromptConstraints(4)
        self.assertEqual(check_operator(constraints, "短句ok")["status"], "passed")
        self.assertEqual(constraints("短句ok").status, "allow")
        for text in ("     ", "longer", "a\x00b"):
            self.assertEqual(constraints(text).status, "reject")
        with self.assertRaises(ValueError):
            PromptConstraints(True)

    def test_configuration_roundtrips_and_scopes_cannot_overlap(self):
        self.assertEqual(self.algorithm.describe(), clone(self.algorithm).describe())
        with self.assertRaises(ValueError):
            ReflectiveSearch(("same",), ("same",))
        with self.assertRaises(ValueError):
            ReflectiveSearch(("train",), ("dev",), target_characters=1800)
        self.view.tasks = (SimpleNamespace(id="train"),)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.algorithm.step(self.view, StateTree())

    def test_evaluations_and_reflection_material_have_disjoint_scopes(self):
        baseline = self.algorithm.step(self.view, StateTree())
        plan = baseline.calls[0].effect["input"]["plan"]
        self.assertEqual([item["task_id"] for item in plan["tasks"]], ["dev"])
        training = self.algorithm._read(self.state())
        plan = training.calls[0].effect["input"]["plan"]
        self.assertEqual([item["task_id"] for item in plan["tasks"]], ["train"])
        proposal = self.algorithm._propose(self.view, self.state(), "initial")
        material = proposal.calls[0].effect["input"]
        self.assertEqual(material["task_ids"], ["train"])
        self.assertEqual(
            [item.get("kind") for item in material["sources"]], [None, "evidence_set", "assessment"]
        )
        self.assertNotIn(self.evidence("dev")["ref"], material["sources"])
        self.assertNotIn("history", material["data"])

    def test_repair_is_a_stable_call_and_only_valid_text_is_materialized(self):
        state = self.state()
        rejected = self.algorithm._handle_proposal(self.view, state, {"text": "x" * 41})
        self.assertEqual(
            rejected.to_dict(),
            clone(self.algorithm)
            ._handle_proposal(
                self.view, StateTree.from_state_dict(json_value(state)), {"text": "x" * 41}
            )
            .to_dict(),
        )
        call = rejected.calls[0]
        self.assertEqual(call.key, "round-0/revise/1")
        self.assertEqual(call.effect["kind"], "meta")
        self.view.results = Results((CallResult(call.ref, "succeeded", {"text": "check counts"}),))
        accepted = self.algorithm.step(self.view, rejected.state)
        self.assertEqual(accepted.calls[0].effect["kind"], "candidate")
        self.assertEqual(accepted.records[0]["status"], "allow")
        self.assertEqual(accepted.records[0]["attempt"], 1)

    def test_exhausted_repairs_reject_without_execution_or_publication(self):
        rejected = self.algorithm._handle_proposal(
            self.view, self.state(proposal_attempt=1), {"text": "x" * 41}
        )
        self.assertEqual(rejected.calls, ())
        self.assertEqual(rejected.terminal.kind, "stop")
        self.assertFalse(rejected.records[-1]["accepted"])
        self.assertEqual(rejected.state.data["current"]["candidate_id"], "anchor")

    def test_infrastructure_failure_is_not_retried_as_a_constraint_failure(self):
        pending = CallRef("round-0/revise/1", digest("pending"))
        state = self.state(phase="revise", proposal_attempt=1, pending=pending)
        self.view.results = Results((CallResult(pending, "failed", error={"message": "offline"}),))
        result = self.algorithm.step(self.view, state)
        self.assertEqual(result.state, state)
        self.assertEqual(result.calls, ())
        self.assertEqual(result.terminal.outcome["status"], "failed")

    def test_incomplete_or_foreign_training_evidence_cannot_drive_proposals(self):
        for status in ("scoring_failed", "environment_failed"):
            stopped = self.algorithm._training_ready(
                self.state(), self.evidence(status=status, score=None)
            )
            self.assertEqual(stopped.calls, ())
            self.assertEqual(stopped.terminal.outcome["status"], "incomplete_training_evidence")
        with self.assertRaisesRegex(ValueError, "different candidate or task scope"):
            self.algorithm._training_ready(self.state(), self.evidence("dev"))
        missing = self.evidence()
        missing["records"] = []
        self.assertEqual(self.algorithm._training_ready(self.state(), missing).calls, ())

    def test_training_pages_resume_before_prompt_read_and_reject_corruption(self):
        pending = CallRef("round-0/training", digest("pending"))
        full = self.evidence()
        unloaded = {**full, "records": [], "loaded": False}
        self.view.results = Results((CallResult(pending, "succeeded", unloaded),))
        decision = self.algorithm.step(self.view, self.state(phase="training", pending=pending))
        raw = json.dumps({k: v for k, v in full.items() if k not in ("ref", "loaded")}).encode()
        offset = 0
        for index, chunk in enumerate((raw[:100], raw[100:])):
            page = {
                "ref": full["ref"],
                "path": None,
                "total_bytes": len(raw),
                "content_digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
                "offset": offset,
                "encoding": "base64",
                "content": base64.b64encode(chunk).decode(),
                "complete": index == 1,
                "cursor": None if index == 1 else "next-page",
            }
            call = decision.calls[0]
            self.assertEqual(call.key, f"round-0/training/evidence/{index}")
            self.view.results = Results((CallResult(call.ref, "succeeded", page),))
            restored = StateTree.from_state_dict(json_value(decision.state))
            if index == 1:
                bad = {**page, "offset": offset + 1}
                self.view.results = Results((CallResult(call.ref, "succeeded", bad),))
                with self.assertRaisesRegex(ValueError, "contiguous"):
                    clone(self.algorithm).step(self.view, restored)
                self.view.results = Results((CallResult(call.ref, "succeeded", page),))
            decision = clone(self.algorithm).step(self.view, restored)
            offset += len(chunk)
        self.assertEqual(decision.state.data["phase"], "read")
        self.assertEqual(decision.state.data["training_evidence"], full)
        self.assertEqual(decision.calls[0].effect["input"]["path"], "AGENTS.md")


if __name__ == "__main__":
    unittest.main()
