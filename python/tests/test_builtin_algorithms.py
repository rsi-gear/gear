"""Resume invariants of the packaged algorithm implementations."""

import unittest
from types import SimpleNamespace

from gear.algorithms import DarwinX
from gear.canonical import digest
from gear.core import ArtifactRef, CallRef, CallResult, CandidateRef, Results, StateTree
from gear.core._json import json_value
from gear.evaluation import EvidenceSet, EvidenceSetSpec, TaskSamples


class BuiltinAlgorithmTests(unittest.TestCase):
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
