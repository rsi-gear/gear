import unittest
import base64
import hashlib
from dataclasses import asdict, replace
from types import SimpleNamespace

from gear.canonical import digest
from gear.ops import (
    ApplyEdits,
    ApplyInput,
    ArtifactRef,
    CallResult,
    CandidateRef,
    CheckEdits,
    CompareCandidates,
    ComparisonInput,
    ComparisonPlan,
    CounterDelta,
    EditCheckInput,
    EditPlan,
    EvidenceRecord,
    EvidenceSet,
    EvidenceSetSpec,
    ExecutionInput,
    FileContent,
    FileEdit,
    MergePlaybook,
    Meta,
    PlaybookDelta,
    PlaybookEntry,
    PlaybookInput,
    Results,
    SamplePlan,
    ScreenedEvaluate,
    ScreenInput,
    TaskSamples,
    clone,
    decode_artifact_pages,
)


def ref(name, kind="assessment"):
    return ArtifactRef("run", kind, digest(name))


class EditTests(unittest.TestCase):
    def test_material_pages_reject_gaps_mixed_snapshots_and_corrupted_bytes(self):
        content = "中文 UTF-8 content".encode()
        pages = tuple(
            {
                "ref": asdict(ref("material", "blob")),
                "path": None,
                "encoding": "base64",
                "content": base64.b64encode(content[offset : offset + 2]).decode(),
                "content_digest": "sha256:" + hashlib.sha256(content).hexdigest(),
                "offset": offset,
                "total_bytes": len(content),
                "complete": offset + 2 >= len(content),
                "cursor": None if offset + 2 >= len(content) else str(offset + 2),
            }
            for offset in range(0, len(content), 2)
        )
        self.assertEqual(decode_artifact_pages(pages), content)
        for broken in (
            pages[1:],
            pages[::-1],
            pages + (pages[-1],),
            ({**pages[0], "content": "YWJj"},) + pages[1:],
            ({**pages[0], "path": "other"},) + pages[1:],
        ):
            with self.subTest(pages=broken), self.assertRaises(ValueError):
                decode_artifact_pages(broken)

    def test_no_change_can_be_checked_without_admitting_an_empty_materialization(self):
        from gear.ops import MaterializeCandidate, MaterializeInput

        material = ApplyInput({"prompt.txt": FileContent("same")}, EditPlan(()))
        self.assertEqual(CheckEdits()(EditCheckInput(material)).status, "allow")
        with self.assertRaises(ValueError):
            MaterializeCandidate()(
                MaterializeInput(CandidateRef("run", "anchor", digest("target")), material.plan),
                key="empty",
            )

    def test_exact_plan_is_atomic_and_rollback_preserves_unrelated_files(self):
        original = {"prompt.txt": FileContent("before\n"), "other.txt": FileContent("untouched")}
        plan = EditPlan(
            (
                FileEdit(
                    "replace", "prompt.txt", original["prompt.txt"].digest, FileContent("after\n")
                ),
                FileEdit("create", "skill.md", None, FileContent("技能\n")),
            )
        )
        updated = ApplyEdits()(ApplyInput(original, plan))
        self.assertEqual(original["prompt.txt"].content, "before\n")
        self.assertNotIn("skill.md", original)
        self.assertEqual(updated["skill.md"].content, "技能\n")
        rollback = EditPlan(
            (
                FileEdit(
                    "replace", "prompt.txt", updated["prompt.txt"].digest, original["prompt.txt"]
                ),
            )
        )
        restored = ApplyEdits()(ApplyInput(updated, rollback))
        self.assertEqual(restored["prompt.txt"], original["prompt.txt"])
        self.assertEqual(restored["other.txt"], original["other.txt"])
        self.assertEqual(restored["skill.md"], updated["skill.md"])
        bad = EditPlan(
            (plan.edits[0], FileEdit("replace", "other.txt", digest("wrong"), FileContent("bad")))
        )
        with self.assertRaisesRegex(ValueError, "precondition"):
            ApplyEdits()(ApplyInput(original, bad))
        self.assertEqual(original["prompt.txt"].content, "before\n")

    def test_patch_requires_exact_positions_context_counts_and_newlines(self):
        original = FileContent("one\ntwo\nthree")
        patch = "--- a/a.txt\n+++ b/a.txt\n@@ -2,2 +2,2 @@\n-two\n+TWO\n three\n\\ No newline at end of file\n"
        edit = FileEdit("patch", "a.txt", original.digest, patch=patch)
        result = ApplyEdits()(ApplyInput({"a.txt": original}, EditPlan((edit,))))
        self.assertEqual(result["a.txt"].content, "one\nTWO\nthree")
        for wrong in (
            patch.replace("-2,2", "-1,2"),
            patch.replace("-two", "-nope"),
            patch.replace("+2,2", "+3,2"),
            patch.replace("+2,2", "+2,3"),
        ):
            with self.subTest(patch=wrong), self.assertRaises(ValueError):
                ApplyEdits()(
                    ApplyInput({"a.txt": original}, EditPlan((replace(edit, patch=wrong),)))
                )

    def test_incomplete_material_is_not_allowed_and_paths_are_bounded(self):
        material = ApplyInput(
            {}, EditPlan((FileEdit("create", "skill.md", None, FileContent("new")),))
        )
        check = CheckEdits(allowed_paths=("*.py",))
        self.assertEqual(
            check(EditCheckInput(material, complete=False)).status, "insufficient_evidence"
        )
        self.assertEqual(check(EditCheckInput(material)).status, "reject")
        for path in ("../secret", "/absolute", "a//b", "a/../b", "a\\b"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                FileEdit("create", path, None, FileContent("bad"))
        with self.assertRaisesRegex(ValueError, "collision"):
            ApplyEdits()(
                ApplyInput(
                    {"dir": FileContent("existing")},
                    EditPlan((FileEdit("create", "dir/file", None, FileContent("new")),)),
                )
            )

    def test_patch_offsets_count_lf_lines_and_preserve_unicode_separators(self):
        original = FileContent("one\u2028inside\nsecond\n")
        patch = "--- a.txt\n+++ a.txt\n@@ -2 +2 @@\n-second\n+updated\n"
        edit = FileEdit("patch", "a.txt", original.digest, patch=patch)
        result = ApplyEdits()(ApplyInput({"a.txt": original}, EditPlan((edit,))))
        self.assertEqual(result["a.txt"].content, "one\u2028inside\nupdated\n")


class EvidenceTests(unittest.TestCase):
    tasks = (TaskSamples("large", (0, 1)), TaskSamples("small", (0, 1)))
    weights = (("large", 0.8), ("small", 0.2))
    objective = digest(None)

    def evidence(self, name, scores):
        candidate = CandidateRef("run", name, digest(name))
        records = tuple(
            EvidenceRecord(
                f"{name}/{task.task_id}/{slot}",
                "attempt-0",
                ref(f"{name}/{task.task_id}/{slot}"),
                task.task_id,
                slot,
                score,
                "valid" if score is not None else "environment_failed",
            )
            for (task, slot), score in zip(
                ((task, slot) for task in self.tasks for slot in task.slots), scores
            )
        )
        spec = EvidenceSetSpec(
            candidate,
            tuple(item.assessment for item in records),
            self.tasks,
            self.weights,
            self.objective,
        )
        return EvidenceSet(ref(name + "/set", "evidence_set"), spec, records, True)

    def compare(self, *sets):
        return ComparisonInput(
            ComparisonPlan(
                tuple(item.spec.candidate for item in sets),
                tuple(item.ref for item in sets),
                self.weights,
                self.tasks,
                self.objective,
            ),
            sets,
        )

    def test_comparison_has_explicit_weighted_scope_and_keeps_failures_incomplete(self):
        first = self.evidence("first", (1, 1, 0, 0))
        second = self.evidence("second", (0, 0, 1, 1))
        failed = self.evidence("failed", (1, None, 1, 1))
        result = CompareCandidates()(self.compare(first, second, failed))
        self.assertEqual(result.order, ("first", "second"))
        self.assertEqual(dict(result.scores), {"first": 0.8, "second": 0.2})
        self.assertEqual(result.incomplete, ("failed",))
        unloaded = CompareCandidates()(self.compare(replace(first, loaded=False)))
        self.assertEqual(unloaded.unloaded, ("first",))
        self.assertEqual(unloaded.incomplete, ())

    def test_retry_is_not_an_extra_sample_and_new_sets_do_not_change_old_sets(self):
        first = self.evidence("first", (1, 1, 0, 0))
        duplicate = replace(first.records[0], attempt_id="retry-1")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            CompareCandidates()(self.compare(replace(first, records=first.records + (duplicate,))))
        original = CompareCandidates()(self.compare(first))
        other = self.evidence("other", (1, 1, 1, 1))
        with self.assertRaisesRegex(ValueError, "explicit"):
            CompareCandidates()(replace(self.compare(first), evidence=(first, other)))
        self.assertEqual(CompareCandidates()(self.compare(first)), original)
        incompatible = replace(
            first, spec=replace(first.spec, objective_ref=digest("other objective"))
        )
        with self.assertRaisesRegex(ValueError, "incompatible"):
            CompareCandidates()(self.compare(incompatible))

    def test_custom_objective_uses_bound_raw_metrics_instead_of_native_scores(self):
        objective = {
            "definition": {
                "terms": [
                    {
                        "metric": "quality",
                        "metricContractDigest": "quality-v1",
                        "weight": 1,
                        "scale": 100,
                    }
                ],
                "constraints": [],
                "comparisonPrecision": 1e-9,
            },
            "metrics": [{"id": "quality", "digest": "quality-v1", "unit": "points"}],
        }
        self.objective = digest(objective)
        first, second = self.evidence("first", (1, 1, 1, 1)), self.evidence("second", (1, 1, 1, 1))

        def quality(item, number):
            return replace(
                item,
                records=tuple(
                    replace(
                        record,
                        raw_metrics={
                            "quality": {
                                "contractDigest": "quality-v1",
                                "unit": "points",
                                "status": "available",
                                "value": number,
                                "evidenceRefs": [record.assessment.digest],
                            }
                        },
                    )
                    for record in item.records
                ),
            )

        first, second = quality(first, 10), quality(second, 90)
        comparison = replace(self.compare(first, second), objective=objective)
        result = CompareCandidates()(comparison)
        self.assertEqual(result.order, ("second", "first"))
        self.assertEqual(dict(result.scores), {"first": 0.1, "second": 0.9})
        with self.assertRaisesRegex(ValueError, "objective"):
            CompareCandidates()(replace(comparison, objective=None))
        missing = replace(
            first, records=(replace(first.records[0], raw_metrics=None),) + first.records[1:]
        )
        self.assertEqual(
            CompareCandidates()(replace(comparison, evidence=(missing, second))).incomplete,
            ("first",),
        )

    def test_evidence_pages_require_contiguous_coverage_and_one_snapshot(self):
        item = self.evidence("first", (1, 0, 1, 0))
        body = asdict(item)
        first = {
            **body,
            "records": body["records"][:2],
            "loaded": False,
            "offset": 0,
            "total_records": 4,
            "cursor": "second",
            "complete": False,
        }
        second = {
            **body,
            "records": body["records"][2:],
            "loaded": False,
            "offset": 2,
            "total_records": 4,
            "cursor": None,
            "complete": True,
        }
        loaded = EvidenceSet.from_pages((first, second))
        self.assertEqual(loaded, item)
        self.assertEqual(CompareCandidates()(self.compare(loaded)).order, ("first",))
        with self.assertRaisesRegex(ValueError, "contiguous"):
            EvidenceSet.from_pages((second,))
        with self.assertRaisesRegex(ValueError, "contiguous"):
            EvidenceSet.from_pages((first, {**second, "ref": asdict(ref("other"))}))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            EvidenceSet.from_pages((first, {**second, "records": first["records"]}))

    def test_plan_modes_do_not_silently_substitute_for_each_other(self):
        self.assertEqual(SamplePlan(self.tasks).plan_id, "fixed")
        self.assertIsNone(SamplePlan(self.tasks, "fresh", None).plan_id)
        with self.assertRaises(ValueError):
            SamplePlan(self.tasks, "fresh")
        with self.assertRaises(ValueError):
            SamplePlan(self.tasks, "reuse", None)
        with self.assertRaises(ValueError):
            SamplePlan(self.tasks, randomness="paired")


class CompositionTests(unittest.TestCase):
    def fixture(self):
        execution = ExecutionInput(
            CandidateRef("run", "candidate", digest("candidate")),
            SamplePlan((TaskSamples("task", (0,)),)),
        )
        edits = EditCheckInput(
            ApplyInput(
                {}, EditPlan((FileEdit("create", "prompt.txt", None, FileContent("new prompt")),))
            )
        )
        return ScreenInput(execution, edits)

    def test_critic_rejection_and_insufficient_material_never_emit_evaluation(self):
        module = ScreenedEvaluate(Meta("review edits", {"type": "object"}))
        value = self.fixture()
        missing = module(
            replace(value, edits=replace(value.edits, complete=False)),
            view=SimpleNamespace(results=Results()),
            key="screen",
        )
        self.assertTrue(missing.done)
        self.assertEqual(missing.calls, ())
        self.assertEqual(missing.result.verdict.status, "insufficient_evidence")
        for status in ("reject", "insufficient_evidence"):
            first = clone(module)(value, view=SimpleNamespace(results=Results()), key="screen")
            self.assertEqual([call.effect["kind"] for call in first.calls], ["meta"])
            result = CallResult(
                first.calls[0].ref, "succeeded", {"status": status, "reason": "reviewed"}
            )
            second = clone(module)(
                value,
                view=SimpleNamespace(results=Results((result,))),
                state=first.state,
                key="screen",
            )
            self.assertTrue(second.done)
            self.assertEqual(second.calls, ())
            self.assertEqual(second.result.status, "screened")
            self.assertIsNone(second.result.evaluation)

    def test_accepted_screening_rebuilds_each_phase_and_binds_the_receipt(self):
        module = ScreenedEvaluate(Meta("review edits", {"type": "object"}))
        value = self.fixture()
        first = module(value, view=SimpleNamespace(results=Results()), key="screen")
        critic = CallResult(
            first.calls[0].ref, "succeeded", {"status": "allow", "reason": "reviewed"}
        )
        second = clone(module)(
            value, view=SimpleNamespace(results=Results((critic,))), state=first.state, key="screen"
        )
        call = second.calls[0]
        self.assertEqual(call.effect["kind"], "execute")
        self.assertEqual(
            call.effect["input"]["screening"]["request_digest"], critic.ref.request_digest
        )
        evaluation = CallResult(call.ref, "succeeded", {"evidence_set": "bound-ref"})
        third = clone(module)(
            value,
            view=SimpleNamespace(results=Results((critic, evaluation))),
            state=second.state,
            key="screen",
        )
        self.assertTrue(third.done)
        self.assertEqual(third.result.status, "evaluated")
        self.assertEqual(third.result.screening_receipt, critic.ref)

    def test_ace_delta_has_stable_ids_counts_and_does_not_mutate_its_input(self):
        old = PlaybookEntry.create("Check assumptions")
        new = PlaybookEntry.create("Verify output")
        value = PlaybookInput(
            (old,), PlaybookDelta(add=(new,), counters=(CounterDelta(old.id, helpful=2),))
        )
        result = MergePlaybook()(value)
        self.assertEqual(result, clone(MergePlaybook())(value))
        self.assertEqual(next(item for item in result if item.id == old.id).helpful, 2)
        self.assertEqual(old.helpful, 0)
        self.assertEqual(new.id, PlaybookEntry.create("Verify output").id)
        with self.assertRaisesRegex(ValueError, "already exists"):
            MergePlaybook()(PlaybookInput((old,), PlaybookDelta(add=(old,))))


if __name__ == "__main__":
    unittest.main()
