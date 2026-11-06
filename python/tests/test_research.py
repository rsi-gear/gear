import copy
import unittest

from gear.algorithms.research import project_research


def fixture():
    objects = []

    def add(kind, value):
        objects.append({"kind": kind, "value": value})

    add(
        "conditions",
        {
            "tasks": [{"id": task} for task in ("a", "b")],
            "repetitions": 2,
            "anchor": {"id": "anchor"},
            "objective": None,
        },
    )
    for candidate in ("anchor", "specialist", "invalid", "absent"):
        add("candidate", {"id": candidate, "digest": candidate})
    for candidate, scores in (("anchor", (0, 1)), ("specialist", (1, 0)), ("invalid", (0, 0))):
        for task, score in zip(("a", "b"), scores):
            for repetition in range(2):
                add(
                    "evidence",
                    {
                        "candidate_id": candidate,
                        "task_id": task,
                        "repetition": repetition,
                        "score": score if candidate != "invalid" else None,
                        "status": "valid" if candidate != "invalid" else "infrastructure_failed",
                    },
                )
    add(
        "decision",
        {
            "step_id": 3,
            "decision_digest": "decision-3",
            "records": [
                {
                    "kind": "scope",
                    "scope": "local-a",
                    "task_ids": ["a"],
                    "candidate_ids": ["anchor", "specialist", "invalid", "absent"],
                    "data": {"weights": {"a": 1}},
                },
                {
                    "kind": "parents",
                    "scope": "all",
                    "task_ids": ["a", "b"],
                    "candidate_ids": ["anchor"],
                    "data": {"plan": {"selected": "anchor", "probabilities": [["anchor", 1]]}},
                },
            ],
        },
    )
    add(
        "operation",
        {
            "operation_id": "gen-1",
            "operation": {
                "kind": "generate_candidate",
                "parent_id": "anchor",
                "candidate_id": "specialist",
            },
            "status": "complete",
            "receipt": {"result": {"status": "complete"}},
        },
    )
    return {"objects": objects}


class ResearchTests(unittest.TestCase):
    def test_large_projection_is_explicitly_bounded_before_expanding_profiles(self):
        source = fixture()
        source["objects"][0]["value"]["repetitions"] = 10000
        with self.assertRaisesRegex(ValueError, "10000 scoped slots"):
            project_research(source)

    def test_scope_profiles_keep_specialists_and_distinguish_zero_invalid_and_absent(self):
        source = fixture()
        before = copy.deepcopy(source)
        result = project_research(source)
        self.assertEqual(source, before)
        global_scope, local = result["scopes"]
        self.assertEqual(local["task_leaders"], {"a": ["specialist"]})
        self.assertEqual(global_scope["task_leaders"], {"a": ["specialist"], "b": ["anchor"]})
        profiles = {item["candidate_id"]: item for item in local["profiles"]}
        self.assertEqual(profiles["anchor"]["score"], 0)
        self.assertTrue(profiles["anchor"]["complete"])
        self.assertIsNone(profiles["invalid"]["score"])
        self.assertFalse(profiles["invalid"]["complete"])
        self.assertEqual(profiles["invalid"]["observed"], 2)
        self.assertEqual(profiles["absent"]["observed"], 0)
        self.assertEqual(profiles["absent"]["expected"], 2)
        self.assertEqual(
            result["parent_selections"][0]["record"]["data"]["plan"]["selected"], "anchor"
        )
        self.assertEqual(result["generations"][0]["parent_id"], "anchor")

    def test_identical_task_ids_with_different_weights_have_separate_comparisons(self):
        source = fixture()
        records = source["objects"][-2]["value"]["records"]
        for label, weights in (("weighted", {"a": 0.9, "b": 0.1}), ("alias", {"a": 0.9, "b": 0.1})):
            records.append(
                {
                    "kind": "scope",
                    "scope": label,
                    "task_ids": ["b", "a"],
                    "candidate_ids": ["anchor", "specialist"],
                    "data": {"weights": weights},
                }
            )
        result = project_research(source)
        self.assertEqual(len(result["scopes"]), 3)
        weighted = result["scopes"][-1]
        self.assertEqual(len(weighted["occurrences"]), 2)
        profiles = {item["candidate_id"]: item for item in weighted["profiles"]}
        self.assertEqual(profiles["anchor"]["score"], 0.1)
        self.assertEqual(profiles["specialist"]["score"], 0.9)

    def test_opaque_custom_scope_is_retained_without_inventing_weights(self):
        source = fixture()
        source["objects"][-2]["value"]["records"][0]["data"] = None
        result = project_research(source)
        self.assertEqual(len(result["scopes"]), 1)
        self.assertEqual(result["unavailable_scopes"][0]["reason"], "missing weights")

    def test_partial_repetition_keeps_original_denominator(self):
        source = fixture()
        source["objects"] = [
            item
            for item in source["objects"]
            if not (
                item["kind"] == "evidence"
                and item["value"]["candidate_id"] == "specialist"
                and item["value"]["task_id"] == "a"
                and item["value"]["repetition"] == 1
            )
        ]
        local = project_research(source)["scopes"][1]
        self.assertEqual(local["task_leaders"], {"a": ["anchor"]})
        profile = next(item for item in local["profiles"] if item["candidate_id"] == "specialist")
        self.assertIsNone(profile["score"])
        self.assertEqual((profile["observed"], profile["expected"]), (1, 2))


if __name__ == "__main__":
    unittest.main()
