"""Actual Math-Verify decisions over explicit CPU native-capture fixtures."""

import copy
import importlib.util
import unittest
from dataclasses import asdict, replace
from unittest.mock import patch

import test_diagevo_data
from gear.training.recipes.diagevo import DiagEvoPolicy, GenerationDirective
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier, _last_box
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import ContractError, digest_json


class FinalBoxTests(unittest.TestCase):
    def test_final_outer_box_and_invalid_final_answer_do_not_fall_back(self):
        cases = (
            (r"First \boxed{3}, finally \boxed{\frac{1}{2}}", r"\boxed{\frac{1}{2}}", "boxed"),
            (r"\boxed{\{1,2\}}", r"\boxed{\{1,2\}}", "boxed"),
            (r"\boxed{3}, finally \boxed{x+\boxed{2}}", None, "nested_box"),
            (r"\boxed{3}, finally \boxed{\frac{1}{2}", None, "unbalanced_box"),
            ("There is no final answer.", None, "missing_box"),
        )
        for text, answer, status in cases:
            with self.subTest(text=text):
                self.assertEqual(_last_box(text), (answer, status))


@unittest.skipUnless(
    importlib.util.find_spec("math_verify") is not None,
    "install training-math to exercise the actual mathematical comparator",
)
class MathAnswerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_diagevo_data.NativeRewardTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = self.fixture.store
        self.classifier = DiagEvoMathClassifier(self.store)
        self.questions = {"solve": "What is one divided by two?"}
        self.request = copy.deepcopy(self.fixture.request)
        self.request["trainingRunId"] = "train-solver"
        self.request["trainDataset"]["tasks"][0]["id"] = "solve"
        self.builder = DiagEvoSolverDatasetBuilder(
            self.store, self.request, policy=DiagEvoPolicy(optimization_group_size=2)
        )

    def captures(self, texts, *, prefix="construction", policy="solver-v1"):
        return tuple(
            self.fixture.capture(
                f"{prefix}/{index}",
                self.questions["solve"],
                text,
                solver=True,
                slot=index,
                policy=policy,
            )
            for index, text in enumerate(texts)
        )

    def classify(self, texts):
        captures = {"solve": self.captures(texts)}
        ref = self.classifier.construction(self.questions, captures)
        labels = {
            row["trajectoryDigest"]: row["answerKey"] for row in self.store.read_json(ref)["labels"]
        }
        return ref, captures, [labels[digest_json(asdict(raw))] for raw in captures["solve"]]

    def pool(self):
        ref, captures, labels = self.classify(
            [r"\boxed{\frac{1}{2}}", r"\boxed{0.5}", r"\boxed{2^{-1}}"] * 3 + [r"\boxed{2}"] * 3
        )
        pool = self.builder.seal_curriculum(
            self.questions,
            captures,
            generation={"solve": GenerationDirective("free")},
            memory=(),
            construction_policy_id="solver-v1",
            answer_classes_ref=ref,
        )
        return pool, captures, labels

    def test_actual_numeric_equivalence_is_stable_under_capture_order(self):
        ref, captures, labels = self.classify(
            [r"\boxed{\frac{1}{2}}", r"\boxed{0.5}", r"\boxed{2^{-1}}", r"\boxed{2}"]
        )
        self.assertEqual(len(set(labels[:3])), 1)
        self.assertNotEqual(labels[0], labels[3])
        self.assertEqual(
            self.classifier.construction(self.questions, {"solve": captures["solve"][::-1]}),
            ref,
        )
        proof = self.store.read_json(self.store.read_json(ref)["labels"][0]["evidenceRef"])
        self.assertEqual(len(proof["comparisons"]), 6)
        self.assertTrue(all(row["status"] == "parsed" for row in proof["captures"]))
        self.assertTrue(all("value" not in row for row in proof["captures"]))

    def test_actual_symbolic_equivalence_and_last_answer(self):
        _, _, labels = self.classify(
            [r"\boxed{(x-1)(x+1)}", r"\boxed{9} then \boxed{x^2-1}", r"\boxed{x^2+1}"]
        )
        self.assertEqual(labels[0], labels[1])
        self.assertNotEqual(labels[0], labels[2])

    def test_missing_and_unsupported_answers_cannot_form_a_majority(self):
        ref, _, labels = self.classify(
            ["", "No answer", r"\boxed{}", r"\boxed{x+\boxed{2}}", r"\boxed{2"]
        )
        self.assertEqual(len(set(labels)), 5)
        self.assertTrue(all(label.startswith("unparsed/") for label in labels))
        proof = self.store.read_json(self.store.read_json(ref)["labels"][0]["evidenceRef"])
        self.assertEqual(
            {row["status"] for row in proof["captures"]},
            {"missing_box", "unsupported_answer", "nested_box", "unbalanced_box"},
        )

    def test_optimization_uses_frozen_classes_and_native_batch_rewards(self):
        pool, _, labels = self.pool()
        raws = self.captures([r"\boxed{50\%}", r"\boxed{7}"], prefix="optimization")
        ref = self.classifier.optimization(pool, (raws,))
        classified = {
            row["trajectoryDigest"]: row["answerKey"] for row in self.store.read_json(ref)["labels"]
        }
        self.assertEqual(classified[digest_json(asdict(raws[0]))], labels[0])
        self.assertTrue(classified[digest_json(asdict(raws[1]))].startswith("unmatched/"))
        lease = {
            **self.fixture.lease,
            "trainingRunId": "train-solver",
            "runtimeInstanceId": "solver-runtime",
            "policyVersion": "solver-v1",
        }
        batch = self.store.read_json(
            self.builder.build((raws,), lease=lease, curriculum_ref=pool, answer_classes_ref=ref)
        )
        samples = self.store.read_json(batch["samplesRef"])[0]
        self.assertEqual([row["reward"] for row in samples], [1, -1])
        for sample, raw in zip(samples, raws, strict=True):
            receipt = self.store.read_json(raw.receipt_refs[0])
            self.assertEqual(
                sample["tokens"],
                self.store.read_json(receipt["inputTokenIdsRef"])
                + self.store.read_json(receipt["outputTokenIdsRef"]),
            )
            self.assertEqual(sample["metadata"]["originalVerifierReward"], 7)

    def test_reference_reuse_and_changed_classifier_are_rejected(self):
        pool, captures, _ = self.pool()
        with self.assertRaisesRegex(ContractError, "cannot reuse"):
            self.classifier.optimization(pool, (captures["solve"][:2],))
        changed = DiagEvoMathClassifier(self.store, float_rounding=5)
        with self.assertRaisesRegex(ContractError, "frozen mathematical classifier"):
            changed.optimization(pool, (self.captures([r"\boxed{0.5}"], prefix="fresh"),))

    def test_capture_coverage_and_actual_request_are_checked(self):
        captures = self.captures([r"\boxed{2}"])
        for questions, rows in (
            ({"different": "What is one divided by two?"}, {"solve": captures}),
            ({"solve": "A different question"}, {"solve": captures}),
            (self.questions, {"solve": (captures[0], captures[0])}),
        ):
            with self.subTest(questions=questions), self.assertRaises(ContractError):
                self.classifier.construction(questions, rows)
        receipt = self.store.read_json(captures[0].receipt_refs[0])
        receipt["complete"] = False
        incomplete = replace(captures[0], receipt_refs=[self.store.put_json(receipt)])
        with self.assertRaises(ContractError):
            self.classifier.construction(self.questions, {"solve": (incomplete,)})

    def test_library_failures_are_not_silently_rewarded_as_disagreement(self):
        for operation in ("parse", "verify"):
            with (
                self.subTest(operation=operation),
                patch("math_verify." + operation, side_effect=TimeoutError("math deadline")),
                self.assertRaisesRegex(TimeoutError, "math deadline"),
            ):
                self.classify([r"\boxed{0.5}"])

    def test_nontransitive_comparisons_cannot_create_answer_classes(self):
        # A tolerance-based comparator can agree on adjacent values but not
        # endpoints. This must fail instead of depending on iteration order.
        def approximate(left, right, **kwargs):
            return abs(int(left) - int(right)) <= 1

        with (
            patch("math_verify.verify", side_effect=approximate),
            self.assertRaisesRegex(ContractError, "transitive partition"),
        ):
            self.classify([r"\boxed{1}", r"\boxed{2}", r"\boxed{3}"])

    def test_one_soft_deadline_covers_reference_replay_and_new_answers(self):
        self.classifier = DiagEvoMathClassifier(self.store, max_seconds=1)
        pool, _, _ = self.pool()
        clock = [0]
        construction = self.classifier._construction

        def slow_reference(*args):
            result = construction(*args)
            clock[0] = 2
            return result

        with (
            patch("gear.training.recipes.diagevo_answers.time.monotonic", lambda: clock[0]),
            patch.object(self.classifier, "_construction", side_effect=slow_reference),
            self.assertRaisesRegex(ContractError, "soft wall-clock budget"),
        ):
            self.classifier.optimization(pool, (self.captures([r"\boxed{0.5}"], prefix="new"),))

    def test_new_answer_cannot_match_two_incompatible_frozen_classes(self):
        from math_verify import verify

        pool, _, _ = self.pool()

        def ambiguous(left, right, **kwargs):
            if "9" in (str(left), str(right)):
                return True
            return verify(left, right, **kwargs)

        with (
            patch("math_verify.verify", side_effect=ambiguous),
            self.assertRaisesRegex(ContractError, "incompatible construction classes"),
        ):
            self.classifier.optimization(pool, (self.captures([r"\boxed{9}"], prefix="ambiguous"),))


if __name__ == "__main__":
    unittest.main()
