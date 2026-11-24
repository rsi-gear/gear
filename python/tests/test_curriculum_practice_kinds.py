"""Executable-environment, replay and synthetic practice have distinct evidence."""

import unittest
from dataclasses import replace

from gear.canonical import digest
from gear.curriculum import (
    GeneratePractice,
    LearningTarget,
    PlanPractice,
    SelectPractice,
    ValidatePractice,
    ValidationEvidence,
)


def draft_for(kind, data, reference):
    generator, validator = GeneratePractice(), ValidatePractice("caller-checker")
    target = LearningTarget("skill", "Reach the requested state", 1, (), ("state-family",))
    plan = PlanPractice(generator.identity, validator.identity, "random", kind=kind)((target,))[0]
    draft = generator.parse(
        {
            "practices": [
                {
                    "instruction": "Practice the target capability",
                    "family": "state-family",
                    "data": data,
                    "reference": reference,
                    "verifier": {"kind": "caller-checker"},
                }
            ]
        },
        plan=plan,
    )[0]
    return generator, validator, draft


def evidence(plan, check, passed, kind):
    draft = plan.drafts[0]
    return ValidationEvidence(
        draft.draft_id,
        draft.digest,
        plan.policy_id,
        plan.validator_id,
        check,
        passed,
        kind,
        ({"proof": digest([draft.digest, check, passed])},),
    )


class PracticeKindsTests(unittest.TestCase):
    def test_environment_reference_and_negative_control_are_really_executed_by_caller(self):
        environment = {"initial": 0, "actions": {"add": 2, "subtract": -1}, "goal": 4}
        generator, validator, draft = draft_for(
            "environment", {"environment": environment}, ["add", "add"]
        )
        self.assertIn("not been executed or admitted", generator.prepare(draft.plan).prompt)
        plan = validator.plan((draft,))

        def execute(actions):
            state = environment["initial"]
            for action in actions:
                state += environment["actions"][action]
            return state == environment["goal"]

        verified = execute(draft.reference)
        calibration = verified and not execute([]) and not execute(["subtract"])
        facts = {
            "environment": environment["initial"] == 0,
            "reference": verified,
            "verifier_calibration": calibration,
            "target_fidelity": True,
            "novelty": True,
        }
        observations = tuple(
            evidence(
                plan,
                check,
                passed,
                "execution"
                if check in ("environment", "reference", "verifier_calibration")
                else "structural",
            )
            for check, passed in facts.items()
        )
        report = validator.assess(plan, observations)
        self.assertTrue(report.results[0].accepted)
        selected = SelectPractice()((draft,), report, budget=1, base_pool_version="pool")
        self.assertEqual(len(selected.selections), 1)
        with self.assertRaisesRegex(ValueError, "execution evidence"):
            validator.assess(plan, (replace(observations[0], kind="semantic"),))

    def test_trajectory_plans_require_replay_evidence_before_selection(self):
        generator, validator, draft = draft_for(
            "trajectory",
            {"trajectory_plan": {"reset": "checkpoint-2", "actions": ["retry"]}},
            {"terminal": "success"},
        )
        self.assertIn("recapture", generator.prepare(draft.plan).prompt)
        plan = validator.plan((draft,))
        self.assertIn("replay", plan.required_checks)
        missing = validator.assess(plan, ())
        self.assertFalse(missing.results[0].accepted)
        self.assertFalse(
            SelectPractice()((draft,), missing, budget=1, base_pool_version="pool").selections
        )
        with self.assertRaisesRegex(ValueError, "execution evidence"):
            validator.assess(plan, (evidence(plan, "replay", True, "semantic"),))

    def test_procedural_examples_require_semantic_checks_and_remain_non_executable(self):
        _, validator, draft = draft_for(
            "example",
            {
                "question": "How can counts be checked?",
                "answer": "Count each constraint independently.",
            },
            {"answer": "Count each constraint independently."},
        )
        plan = validator.plan((draft,))
        self.assertNotIn("environment", plan.required_checks)
        checks = tuple(
            evidence(
                plan, name, True, "semantic" if name == "semantic_correctness" else "structural"
            )
            for name in plan.required_checks
        )
        report = validator.assess(plan, checks)
        self.assertTrue(report.results[0].accepted)
        self.assertEqual(report.results[0].kind, "example")
        with self.assertRaisesRegex(ValueError, "semantic validation"):
            validator.assess(plan, (evidence(plan, "semantic_correctness", True, "structural"),))

    def test_missing_kind_payloads_and_mixed_validation_do_not_gain_admission(self):
        generator, validator, env = draft_for(
            "environment", {"environment": {"initial": 0}}, {"answer": 0}
        )
        invalid = replace(env, data={"environment": {}})
        self.assertTrue(validator.plan((invalid,)).structural_errors)
        _, _, example = draft_for("example", {"question": "Question", "answer": "Answer"}, "Answer")
        with self.assertRaisesRegex(ValueError, "each practice kind separately"):
            validator.plan((env, example))
        with self.assertRaises(ValueError):
            generator.parse(
                {
                    "practices": [
                        {
                            "instruction": "x",
                            "family": "state-family",
                            "data": {},
                            "reference": 0,
                            "verifier": {},
                        }
                    ]
                },
                plan=env.plan,
            )


if __name__ == "__main__":
    unittest.main()
