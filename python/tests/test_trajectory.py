import unittest

from gear.algorithms.trajectory import trajectory_page, trajectory_query
from gear.canonical import digest


class TrajectoryTests(unittest.TestCase):
    def request(self, **query):
        return {
            "snapshot_digest": digest("snapshot"),
            "source_ref": "trajectory:" + "a" * 64,
            "content_digest": digest("content"),
            "query": query,
        }

    def test_normalizes_filters_and_requires_an_exact_sequence_for_detail(self):
        result = trajectory_query(
            self.request(types=["tool/result", "assistant/message", "tool/result"], limit=2)
        )
        self.assertEqual(result["filter"]["types"], ["assistant/message", "tool/result"])
        for invalid in (
            {"limit": 51},
            {"limit": True},
            {"seq_start": 2, "seq_end": 1},
            {"field": "data"},
            {"root": "/private"},
            {"seq_start": 1, "seq_end": 1, "field": "data..text"},
            {"seq_start": 1, "seq_end": 1, "field": "data.[field:bad]"},
        ):
            with self.assertRaises(ValueError):
                trajectory_query(self.request(**invalid))
        self.assertEqual(
            trajectory_query(
                self.request(seq_start=1, seq_end=1, field="data.[field:aabbccddeeff].message")
            )["filter"]["field"],
            "data.[field:aabbccddeeff].message",
        )

    def test_cursor_is_bound_to_snapshot_source_digest_and_filters(self):
        input = self.request(types=["tool/result"])
        query = trajectory_query(input)
        page = trajectory_page(
            {
                "query": query,
                "page": {
                    "events": [],
                    "total_matches": 2,
                    "eof": False,
                    "next_cursor": "opaque-hitch-page",
                },
            }
        )
        again = {**input, "query": {**input["query"], "cursor": page["next_cursor"]}}
        self.assertEqual(trajectory_query(again)["provider_cursor"], "opaque-hitch-page")
        for key in ("snapshot_digest", "source_ref", "content_digest"):
            with self.assertRaisesRegex(ValueError, "another snapshot"):
                trajectory_query({**again, key: digest("other")})
        with self.assertRaisesRegex(ValueError, "another snapshot"):
            trajectory_query({**again, "query": {**again["query"], "types": ["assistant/message"]}})

    def test_pages_are_explicit_about_child_coverage_and_enforce_a_byte_bound(self):
        query = trajectory_query(self.request())
        page = {
            "events": [{"seq": 1, "type": "assistant/message", "data": "你好"}],
            "total_matches": 1,
            "eof": True,
        }
        result = trajectory_page({"query": query, "page": page})
        self.assertEqual(result["scope"], "canonical-session")
        self.assertEqual(result["child_sessions"], "not-included")
        self.assertIsNone(result["next_cursor"])
        self.assertEqual(result["items"], page["events"])
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            trajectory_page({"query": query, "page": {**page, "events": ["界" * 30000]}})


if __name__ == "__main__":
    unittest.main()
