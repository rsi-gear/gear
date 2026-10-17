import copy
import unittest

from gear.algorithms.experience import (
    descriptive,
    encoded_size,
    experience_context,
    experience_query,
    experience_read,
    experience_record,
)
from gear.algorithms.experience_index import verify_snapshot
from gear.canonical import digest


def record(candidate="candidate", before=1, after=0, task="format", path="plugins/format.py"):
    return experience_record(
        {
            "source": {"run_id": "run", "benchmark_digest": digest("benchmark")},
            "candidate": {"id": candidate, "digest": digest(candidate), "parent_id": "parent"},
            "parent": {"id": "parent", "digest": digest("parent"), "parent_id": None},
            "task_ids": [task],
            "repetitions": 2,
            "objective": None,
            "evidence": [
                {
                    "candidate_id": who,
                    "task_id": task,
                    "repetition": repetition,
                    "status": "valid" if score is not None else "environment_failed",
                    "score": score,
                }
                for who, score in (("parent", before), (candidate, after))
                for repetition in range(2)
            ],
            "proposal": {
                "rationale": "preserve exact formatting",
                "hypothesis": "format output",
                "semantic_targets": ["output"],
            },
            "change": {"files": [{"path": path, "change": "modified", "patch": "-old\n+new\n"}]},
        }
    )


def snapshot(records):
    return {"snapshot_digest": digest([item["digest"] for item in records]), "records": records}


class ExperienceTests(unittest.TestCase):
    def test_legacy_optional_metadata_keeps_refs_and_explicit_run_conflicts_fail(self):
        value = record()
        value["source"], value["proposal"] = {}, {}
        del value["verifier_trials"]
        value["digest"] = digest({key: item for key, item in value.items() if key != "digest"})
        body = {
            "version": 2,
            "run_id": "run",
            "source_archive_digest": digest("archive"),
            "implementation_identity": digest("implementation"),
            "records": [value],
        }
        frozen = {**body, "digest": digest(body)}
        original = copy.deepcopy(frozen)
        verify_snapshot(frozen)
        cards = experience_query({"records": [value], "snapshot_digest": frozen["digest"]})
        self.assertEqual(cards["items"][0]["card"]["ref"], "experience:" + value["digest"][7:])
        self.assertEqual(cards["items"][0]["card"]["hypothesis"], "")
        self.assertEqual(frozen, original)
        for owner in ("another-run", None):
            changed = copy.deepcopy(value)
            changed["source"] = {"run_id": owner}
            changed["digest"] = digest(
                {key: item for key, item in changed.items() if key != "digest"}
            )
            changed_body = {**body, "records": [changed]}
            with self.assertRaisesRegex(ValueError, "scope or lineage mismatch"):
                verify_snapshot({**changed_body, "digest": digest(changed_body)})

    def test_verifier_view_paginates_frozen_parent_and_candidate_observations(self):
        value = record()
        expected = value["verifier_trials"]
        self.assertEqual(len(expected), 4)
        self.assertEqual({item["candidate_id"] for item in expected}, {"parent", "candidate"})
        self.assertTrue(
            all(item["observation"]["reason"] == "verifier-not-captured" for item in expected)
        )
        input = {
            **snapshot([value]),
            "ref": "experience:" + value["digest"][7:],
            "view": "verifier",
            "limit": 1,
        }
        items, cursor = [], None
        while True:
            page = experience_read({**input, "cursor": cursor})
            items.extend(page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
            with self.assertRaisesRegex(ValueError, "different snapshot or query"):
                experience_read({**input, "view": "task-results", "cursor": cursor})
        self.assertEqual(items, expected)

    def test_descriptive_projection_keeps_status_and_hashes_private_artifact_locators(self):
        value = {
            "assertions": [
                {
                    "status": "failed",
                    "evidenceRefs": ["/private/provider/trace"],
                    "reason": "PRIVATE_REASON",
                }
            ],
            "score": 0,
        }
        result = descriptive(value)
        self.assertEqual(
            result,
            {
                "assertions": [
                    {
                        "status": "failed",
                        "evidence_ref_digests": [digest("/private/provider/trace")],
                    }
                ],
                "score": 0,
            },
        )
        self.assertEqual(value["assertions"][0]["reason"], "PRIVATE_REASON")

    def test_classifies_actual_parent_comparisons_without_treating_invalid_as_zero(self):
        loss = record()
        self.assertEqual(loss["classification"]["effect"], "regressed")
        self.assertTrue(loss["classification"]["complete"])
        self.assertEqual(loss["task_results"][0]["candidate"]["score"], 0)
        unavailable = record(after=None)
        self.assertEqual(unavailable["classification"]["effect"], "incomparable")
        self.assertFalse(unavailable["classification"]["complete"])
        self.assertEqual(unavailable["classification"]["unavailable_tasks"], 1)
        self.assertIsNone(unavailable["task_results"][0]["gain"])

    def test_query_is_deterministic_filtered_and_keeps_relevant_negative_experiences(self):
        values = [
            record("improvement", 0, 1),
            record("loss", 1, 0),
            record("irrelevant", task="arithmetic", path="math.py"),
        ]
        source = snapshot(values)
        before = copy.deepcopy(source)
        reply = experience_query(
            {**source, "query": {"query": "format", "paths": ["plugins/format.py"]}}
        )
        self.assertEqual(
            [item["card"]["candidate_id"] for item in reply["items"]], ["loss", "improvement"]
        )
        self.assertEqual(source, before)
        filtered = experience_query({**source, "query": {"effects": ["improved"]}})
        self.assertEqual(filtered["total"], 1)
        self.assertEqual(filtered["items"][0]["card"]["classification"]["effect"], "improved")

    def test_cursor_is_bound_to_snapshot_query_and_read_view(self):
        source = snapshot([record("a"), record("b"), record("c")])
        page = experience_query({**source, "limit": 1})
        second = experience_query({**source, "limit": 1, "cursor": page["next_cursor"]})
        self.assertNotEqual(second["items"][0]["card"]["ref"], page["items"][0]["card"]["ref"])
        for change in ({"snapshot_digest": digest("changed")}, {"query": {"query": "format"}}):
            with self.assertRaisesRegex(ValueError, "different snapshot or query"):
                experience_query({**source, **change, "cursor": page["next_cursor"]})
        with self.assertRaisesRegex(ValueError, "outside the frozen snapshot"):
            experience_read({**source, "ref": "experience:" + "0" * 64})

    def test_large_unicode_diff_is_paged_without_losing_or_splitting_characters(self):
        value = record()
        patch = "+中文修改🧪\n" * 8000
        value["change"]["files"][0]["patch"] = patch
        value["digest"] = digest({key: item for key, item in value.items() if key != "digest"})
        source = snapshot([value])
        ref = "experience:" + value["digest"][7:]
        chunks, cursor = [], None
        while True:
            page = experience_read(
                {**source, "ref": ref, "view": "diff", "limit": 2, "cursor": cursor}
            )
            self.assertLessEqual(encoded_size(page), 64 * 1024)
            chunks.extend(item["patch"] for item in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
            with self.assertRaisesRegex(ValueError, "different snapshot or query"):
                experience_read({**source, "ref": ref, "view": "task-results", "cursor": cursor})
        self.assertEqual("".join(chunks), patch)

    def test_modification_use_pages_include_conditioned_summary_inside_the_byte_limit(self):
        value = record()
        trials = value["modification_use"]["trials"]
        # A near-limit item cannot consume the space needed for the added summary.
        trials[0]["artifacts"] = [{"path": "x" * 32000}, {"path": "y" * 32000}]
        value["digest"] = digest({key: item for key, item in value.items() if key != "digest"})
        source = {
            **snapshot([value]),
            "ref": "experience:" + value["digest"][7:],
            "view": "modification-use",
        }
        with self.assertRaisesRegex(ValueError, "bounded read size"):
            experience_read(source)
        trials[0]["artifacts"] = [{"path": "x" * 30000}]
        trials[1]["artifacts"] = [{"path": "y" * 30000}]
        value["digest"] = digest({key: item for key, item in value.items() if key != "digest"})
        source = {
            **snapshot([value]),
            "ref": "experience:" + value["digest"][7:],
            "view": "modification-use",
            "limit": 1,
        }
        first = experience_read(source)
        second = experience_read({**source, "cursor": first["next_cursor"]})
        for page in (first, second):
            self.assertLessEqual(encoded_size(page), 64 * 1024)
            self.assertEqual(page["summary"], value["modification_use"]["summary"])
            unknown = next(
                item
                for item in page["summary"]["conditioned_results"]
                if item["status"] == "unknown"
            )
            self.assertEqual(unknown["valid_pairs"], 2)
            self.assertEqual(unknown["candidate_mean"], 0)
            self.assertEqual(unknown["mean_reward_delta"], -1)

    def test_automatic_cards_include_actual_parent_and_match_failure_beyond_first_fifty_tasks(self):
        source = snapshot(
            [
                record("direct", task="unrelated"),
                record("matching", task="task-99"),
                record("noise", task="other"),
            ]
        )
        result = experience_context(
            {
                **source,
                "parent_id": "direct",
                "evidence": [
                    {"task_id": "task-" + str(index), "score": 0, "status": "valid"}
                    for index in range(100)
                ],
            }
        )
        self.assertEqual([card["candidate_id"] for card in result["cards"]], ["direct", "matching"])
        self.assertLessEqual(encoded_size(result), 12 * 1024)
        empty = experience_context({**source, "parent_id": "none", "evidence": []})
        self.assertEqual(empty["cards"], [])

    def test_rejects_changed_record_and_oversized_queries(self):
        source = snapshot([record()])
        source["records"][0]["classification"]["effect"] = "improved"
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            experience_query(source)
        with self.assertRaises(ValueError):
            experience_query({**snapshot([record()]), "query": {"query": "x" * 1025}})


if __name__ == "__main__":
    unittest.main()
