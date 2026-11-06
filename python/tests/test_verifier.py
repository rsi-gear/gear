import copy
import json
import unittest

from gear.algorithms.verifier import (
    MAX_BYTES,
    bind_verifier_channels,
    project_verifier,
    summarize_verifiers,
    unavailable,
    verifier_feedback,
)
from gear.canonical import digest
from gear.refine.protocol import validate


def fixture():
    run = "run_" + "a" * 32
    trial = {
        "run_id": run,
        "task_id": "task",
        "trial_id": "trial",
        "attempt": 1,
        "observation_status": "valid",
        "reward": 0,
        "verifier_result_ref": "verifier/result.json",
    }
    process = {
        "schema_version": "1",
        "metric": "process_quality",
        "score": 0.25,
        "detail_status": "components",
        "passed": 1,
        "total": 2,
        "excluded": 1,
        "components": [
            {"id": "success", "category": "workflow", "status": "passed", "weight": 1},
            {
                "id": "failure",
                "category": "workflow",
                "status": "failed",
                "weight": 3,
                "code": "missing-check",
                "private_details_ref": "private/SECRET",
                "public_details": {"count": 2},
            },
            {"id": "unused", "category": "workflow", "status": "excluded", "weight": 10},
        ],
    }
    feedback = {
        "schema_version": "1",
        "items": [
            {
                "code": "missing-check",
                "severity": "error",
                "message": "Check recorded evidence",
                "component_ids": ["failure"],
            }
        ],
    }
    source = {
        "schema_version": "1",
        "kind": "verifier-evidence",
        "run_id": run,
        "parent": {"eval_id": "eval_" + "b" * 32, "trial_id": "trial", "attempt": 1},
        "observation": {
            "status": "valid",
            "reward": 0,
            "verifier_result_ref": "verifier/result.json",
        },
        "verifier": {
            "status": "result_only",
            "result_sha256": digest("result"),
            "result": {
                "rewards": {"reward": 0, "total_score": 0, "process_score": 0.25},
                "PRIVATE_RESULT": "private",
            },
            "scores": {"normalization": "standard", "total_score": 0, "process_score": 0.25},
            "process": process,
            "feedback": feedback,
            "structured_artifacts": {
                name: {
                    "ref": f"verifier/{name}.json",
                    "sha256": digest(value),
                    "bytes": len(json.dumps(value).encode()),
                }
                for name, value in (("process", process), ("feedback", feedback))
            },
        },
    }
    trial["scores"] = source["verifier"]["scores"].copy()
    return {"trial": trial, "source": source, "eval_id": source["parent"]["eval_id"]}


class VerifierTests(unittest.TestCase):
    def test_generic_codes_and_unrepresentable_source_do_not_supply_diagnosis(self):
        input = fixture()
        input["source"]["verifier"]["feedback"]["items"][0]["code"] = "Error"
        input["source"]["verifier"]["process"]["components"][1]["code"] = "UNKNOWN"
        self.assertEqual(project_verifier(input)["failure_codes"], [])
        input["source"]["verifier"]["result"]["unsafe"] = 2**54
        value = project_verifier(input)
        self.assertEqual(value["status"], "invalid")
        self.assertIsNone(value["source_digest"])

    def test_provider_namespace_preserves_channel_availability_without_mutation(self):
        for status in ("unsupported", "invalid", "missing", "unavailable"):
            cell = {
                "status": "valid",
                "score": 0,
                "verifier": unavailable(status, "reason"),
                "raw_metrics": {"process": {"status": "missing"}, "other": {"status": "missing"}},
                "assertions": [{"id": "guard", "status": "missing"}],
            }
            input = {
                "evidence": cell,
                "metrics": [{"id": "process", "source": {"path": "verifier.process.score"}}],
                "assertions": [{"id": "guard", "source": {"path": "verifier.result.guard"}}],
            }
            before = copy.deepcopy(input)
            result = bind_verifier_channels(input)
            expected = status if status in ("unsupported", "invalid") else "missing"
            self.assertEqual(result["raw_metrics"]["process"]["status"], expected)
            self.assertEqual(result["assertions"][0]["status"], expected)
            self.assertEqual(result["raw_metrics"]["other"]["status"], "missing")
            self.assertEqual(input, before)

    def test_scope_summary_uses_task_weights_and_requires_every_valid_slot(self):
        cells = [
            {
                "task_id": task,
                "repetition": repetition,
                "status": "valid",
                "verifier": {
                    "status": "available",
                    "process": {"metric": "quality", "score": score},
                },
            }
            for task, score in (("a", 0), ("b", 1))
            for repetition in range(2)
        ]
        full = summarize_verifiers(cells, {"a": 1, "b": 3}, 2)["process_metrics"][0]
        self.assertEqual(
            full,
            {
                "metric": "quality",
                "observed": 4,
                "expected": 4,
                "complete": True,
                "value": 0.75,
                "observed_trial_mean": 0.5,
            },
        )
        for partial in (cells[:-1], cells + [cells[0]]):
            metric = summarize_verifiers(partial, {"a": 1, "b": 3}, 2)["process_metrics"][0]
            self.assertFalse(metric["complete"])
            self.assertIsNone(metric["value"])
        cells[0]["status"] = "environment_failed"
        cells[1]["verifier"] = None
        cells[2]["verifier"]["process"]["metric"] = "different"
        summary = summarize_verifiers(cells, {"a": 1, "b": 3}, 2)
        self.assertEqual(summary["status_counts"]["invalid"], 1)
        self.assertEqual(summary["status_counts"]["not_captured"], 1)
        self.assertTrue(all(item["value"] is None for item in summary["process_metrics"]))

    def test_weighted_process_valid_zero_and_private_source_projection(self):
        input = fixture()
        original = copy.deepcopy(input)
        value = project_verifier(input)
        self.assertEqual(value["status"], "available")
        self.assertEqual(value["primary_score"], 0)
        self.assertEqual(value["process"]["score"], 0.25)
        self.assertEqual(value["process"]["total"], 2)
        self.assertEqual(value["process"]["excluded"], 1)
        self.assertEqual(value["process"]["components"][0]["id"], "failure")
        self.assertEqual(value["failure_codes"], ["missing-check"])
        self.assertEqual(value["source_digest"], digest(input["source"]))
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertNotIn("PRIVATE_RESULT", json.dumps(value))
        self.assertEqual(input, original)
        validate("VerifierObservation", value)
        self.assertIn(
            "hypotheses",
            verifier_feedback({"feedback": "Task assertion failed", "verifier": value}),
        )

    def test_wrong_run_parent_slot_attempt_reward_and_result_cannot_supply_facts(self):
        for mutation in (
            lambda x: x["source"].update(run_id="run_" + "c" * 32),
            lambda x: x["source"]["parent"].update(eval_id="eval_" + "c" * 32),
            lambda x: x["source"]["parent"].update(trial_id="other"),
            lambda x: x["source"]["parent"].update(attempt=2),
            lambda x: x["source"]["observation"].update(reward=1),
            lambda x: x["source"]["verifier"]["result"]["rewards"].update(total_score=1),
            lambda x: x["source"]["verifier"].update(result_sha256="not-a-digest"),
        ):
            input = fixture()
            mutation(input)
            value = project_verifier(input)
            self.assertEqual(value["status"], "invalid")
            self.assertIsNone(value["process"])
            self.assertEqual(value["failure_codes"], [])

    def test_component_count_weight_duplicate_and_aggregate_consistency(self):
        for mutate in (
            lambda p: p.update(passed=2),
            lambda p: p.update(excluded=0),
            lambda p: p.update(score=0),
            lambda p: p["components"][0].update(weight=0),
            lambda p: p["components"][1].update(id="success"),
            lambda p: p.update(detail_status="aggregate-only"),
        ):
            input = fixture()
            mutate(input["source"]["verifier"]["process"])
            self.assertEqual(project_verifier(input)["status"], "invalid")
        input = fixture()
        input["source"]["verifier"]["feedback"]["items"][0]["component_ids"] = ["absent"]
        self.assertEqual(project_verifier(input)["status"], "invalid")

    def test_aggregate_only_and_no_process_are_explicit_not_invented_components(self):
        input = fixture()
        verifier = input["source"]["verifier"]
        verifier["process"] = {
            "schema_version": "1",
            "metric": "quality",
            "score": 0.25,
            "detail_status": "aggregate-only",
        }
        verifier["feedback"]["items"][0].pop("component_ids")
        value = project_verifier(input)
        self.assertEqual(value["status"], "available")
        self.assertIsNone(value["process"]["total"])
        self.assertEqual(value["process"]["components"], [])
        validate("VerifierObservation", value)
        for container in (
            verifier["scores"],
            input["trial"]["scores"],
            verifier["result"]["rewards"],
        ):
            container.pop("process_score")
        verifier.pop("process")
        verifier["structured_artifacts"].pop("process")
        self.assertIsNone(project_verifier(input)["process"])

    def test_missing_corrupt_unsupported_and_invalid_original_never_become_zero(self):
        for status, expected in (("missing", "missing"), ("corrupt", "invalid")):
            input = fixture()
            input["source"]["verifier"] = {"status": status, "issues": ["PRIVATE_ERROR"]}
            value = project_verifier(input)
            self.assertEqual(value["status"], expected)
            self.assertIsNone(value["primary_score"])
            self.assertNotIn("PRIVATE_ERROR", json.dumps(value))
            validate("VerifierObservation", value)
        self.assertEqual(
            project_verifier({"source": None, "unsupported": True})["status"], "unsupported"
        )
        self.assertEqual(project_verifier({"source": None})["status"], "unavailable")
        input = fixture()
        input["trial"]["observation_status"] = "invalid"
        input["source"]["observation"]["status"] = "invalid"
        self.assertEqual(project_verifier(input)["reason"], "invalid-original-observation")

    def test_public_projection_is_bounded_but_counts_cover_all_components(self):
        input = fixture()
        verifier = input["source"]["verifier"]
        components = [
            {
                "id": f"component-{index:04d}",
                "category": "workflow",
                "status": "failed",
                "weight": 1,
                "code": f"failed-{index}",
                "public_details": {"message": "中" * 1000},
            }
            for index in range(300)
        ]
        verifier["process"].update(components=components, score=0, passed=0, total=300, excluded=0)
        for container in (
            verifier["scores"],
            input["trial"]["scores"],
            verifier["result"]["rewards"],
        ):
            container["process_score"] = 0
        verifier["feedback"]["items"] = [
            {"code": f"feedback-{index}", "severity": "error", "message": "中" * 1000}
            for index in range(40)
        ]
        value = project_verifier(input)
        self.assertEqual(value["status"], "available")
        self.assertEqual(
            len(value["process"]["components"]) + value["process"]["omitted_components"], 300
        )
        self.assertEqual(len(value["feedback"]) + value["omitted_feedback"], 40)
        self.assertEqual(len(value["failure_codes"]) + value["omitted_failure_codes"], 340)
        self.assertLessEqual(
            len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()), MAX_BYTES
        )
        self.assertTrue(value["feedback"][0]["message_truncated"])
        validate("VerifierObservation", value)

    def test_protocol_enforces_bounds_on_the_new_closed_observation(self):
        value = project_verifier(fixture())
        for mutate in (
            lambda x: x.update(source_digest="bad"),
            lambda x: x.update(failure_codes=["x"] * 33),
            lambda x: x["feedback"][0].update(message="x" * 513),
            lambda x: x["process"]["components"][0].update(weight=0),
        ):
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.assertRaises(ValueError):
                validate("VerifierObservation", changed)


if __name__ == "__main__":
    unittest.main()
