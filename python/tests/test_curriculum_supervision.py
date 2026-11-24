"""Evidence, permission, replay and pairing boundaries of semantic supervision."""

import json
import unittest
from dataclasses import asdict, replace

from gear.core import clone
from gear.core.testing import check_operator
from gear.curriculum import (
    BuildSupervision,
    ExtractOutcomeCases,
    OutcomeRecord,
    PreferenceJudgment,
    PreferenceSupervision,
    ProceduralExample,
    ProceduralSupervision,
    RepairSupervision,
    RepairVerification,
    SFTSupervision,
    SupervisionTrace,
    TrajectoryVerification,
)


def trace(name="success", passed=True, **changes):
    record = OutcomeRecord("task", "family", name, 0, "policy", "env", "completed", passed, True)
    value = SupervisionTrace(
        ExtractOutcomeCases()((record,))[0],
        {"trajectory": name},
        {"state": "initial"},
        4,
        final_state_ref={"state": "final-" + name},
    )
    return replace(value, **changes)


def verified(value, kind="success", through_step=None):
    return TrajectoryVerification(
        value.digest,
        kind,
        value.steps if through_step is None else through_step,
        ({"proof": kind},),
        "verifier",
    )


class SupervisionTests(unittest.TestCase):
    def test_success_and_prefix_require_independent_trace_bound_proofs(self):
        builder = BuildSupervision()
        success, failed = trace(), trace("failed", False)
        request = SFTSupervision(success, verified(success))
        result = builder(request)
        self.assertEqual(result.kind, "sft_success")
        self.assertEqual(check_operator(builder, request)["status"], "passed")
        self.assertEqual(clone(builder).describe(), builder.describe())
        self.assertEqual(result.spans[0].stop_step, 4)
        with self.assertRaisesRegex(ValueError, "exact trace"):
            builder(SFTSupervision(failed, verified(success)))
        with self.assertRaisesRegex(ValueError, "complete success"):
            builder(SFTSupervision(failed, verified(failed)))
        prefix = builder(SFTSupervision(failed, verified(failed, "prefix", 2)))
        self.assertEqual(prefix.kind, "sft_prefix")
        self.assertEqual(prefix.spans[0].stop_step, 2)
        with self.assertRaises(ValueError):
            builder(SFTSupervision(failed, verified(failed, "prefix", 5)))

    def test_protocol_fields_do_not_expand_caller_material_grants(self):
        source = trace(material_protocol="gold_answer_allowed")
        request = SFTSupervision(source, verified(source))
        with self.assertRaisesRegex(ValueError, "explicit grant"):
            BuildSupervision()(request)
        result = BuildSupervision()(request, allowed_protocols=("gold_answer_allowed",))
        self.assertEqual(result.material_protocols, ("gold_answer_allowed",))
        hidden = replace(source.case.record, partition="test")
        with self.assertRaisesRegex(ValueError, "permitted"):
            BuildSupervision()(
                replace(request, trace=replace(source, case=replace(source.case, record=hidden)))
            )

    def test_repair_masks_only_new_capture_and_requires_execution_state_binding(self):
        failed, revised = trace("failed", False), trace("replayed")
        execution = RepairVerification(
            failed.digest,
            revised.digest,
            "verified_replay",
            revised.initial_state_ref,
            ({"replay": "verified"},),
            "reset-verifier",
        )
        request = RepairSupervision(failed, revised, 2, execution, verified(revised))
        result = BuildSupervision()(request)
        self.assertEqual(
            [(part.start_step, part.stop_step, part.loss) for part in result.spans],
            [(0, 2, False), (2, 4, True)],
        )
        self.assertTrue(all(part.trajectory_ref == revised.trajectory_ref for part in result.spans))
        for changed in (
            replace(execution, verified=False),
            replace(execution, start_state_ref={"state": "wrong"}),
            replace(execution, failure_digest="wrong"),
        ):
            with self.assertRaisesRegex(ValueError, "execution proof"):
                BuildSupervision()(replace(request, execution=changed))
        with self.assertRaisesRegex(ValueError, "separately captured"):
            duplicate = replace(revised, trajectory_ref=failed.trajectory_ref)
            BuildSupervision()(
                replace(request, revised=duplicate, verification=verified(duplicate))
            )
        with self.assertRaisesRegex(ValueError, "nonempty captured suffix"):
            BuildSupervision()(replace(request, loss_start_step=4))

    def test_terminal_continuation_must_start_from_actual_failed_state(self):
        failed = trace("failed", False)
        revised = trace("continued", initial_state_ref=failed.final_state_ref)
        execution = RepairVerification(
            failed.digest,
            revised.digest,
            "terminal_continue",
            revised.initial_state_ref,
            ("continuation-proof",),
            "verifier",
        )
        result = BuildSupervision()(
            RepairSupervision(failed, revised, 0, execution, verified(revised))
        )
        self.assertEqual(len(result.spans), 1)
        bad = replace(failed, final_state_ref=None)
        with self.assertRaisesRegex(ValueError, "actual failed terminal state"):
            BuildSupervision()(
                RepairSupervision(
                    bad,
                    revised,
                    0,
                    replace(execution, failure_digest=bad.digest),
                    verified(revised),
                )
            )

    def test_trajectory_and_step_preferences_have_different_pairing_rules(self):
        chosen, rejected = trace(), trace("rejected", False)
        judgment = PreferenceJudgment(
            chosen.digest, rejected.digest, "majority_vote", ("vote-record",), 0.75
        )
        request = PreferenceSupervision(chosen, rejected, judgment)
        result = BuildSupervision()(request)
        self.assertEqual(result.label_source, "majority_vote")
        self.assertEqual(result.confidence, 0.75)
        self.assertNotEqual(chosen.final_state_ref, rejected.final_state_ref)
        with self.assertRaisesRegex(ValueError, "same decision prefix"):
            BuildSupervision()(
                replace(
                    request,
                    scope="step",
                    chosen_prefix_ref="prefix-a",
                    rejected_prefix_ref="prefix-b",
                )
            )
        step = BuildSupervision()(
            replace(request, scope="step", chosen_prefix_ref="prefix", rejected_prefix_ref="prefix")
        )
        self.assertEqual(step.preference.scope, "step")
        different = replace(rejected, initial_state_ref="different-start")
        with self.assertRaisesRegex(ValueError, "same task and start"):
            BuildSupervision()(
                replace(
                    request,
                    rejected=different,
                    judgment=replace(judgment, rejected_digest=different.digest),
                )
            )

    def test_procedural_examples_stay_synthetic_and_have_no_native_training_fields(self):
        example = ProceduralExample(
            trace("failed", False).case,
            "How to check counts?",
            "Check every constraint separately.",
            ("semantic-validation",),
        )
        result = BuildSupervision()(ProceduralSupervision((example,)))
        self.assertEqual(result.kind, "synthetic_procedural")
        self.assertEqual(result.label_source, "synthetic")
        self.assertEqual(result.spans, ())
        encoded = json.dumps(asdict(result))
        self.assertNotIn("logprob", encoded)
        self.assertNotIn("token", encoded)
        with self.assertRaisesRegex(ValueError, "duplicate synthetic"):
            BuildSupervision()(ProceduralSupervision((example, example)))
        with self.assertRaisesRegex(ValueError, "unauthorized"):
            BuildSupervision()(
                ProceduralSupervision((replace(example, material_protocol="gold_answer_allowed"),))
            )


if __name__ == "__main__":
    unittest.main()
