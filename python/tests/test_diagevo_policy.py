"""Paper-specific vote, scheduling and active-episode rules; no fake training run."""

import unittest
from dataclasses import replace

from gear.core import DeterministicRandom, clone
from gear.training.recipes.diagevo import (
    Cause,
    DiagEvoPolicy,
    FailureAttribution,
    GenerationDirective,
    SolverSample,
)


def samples(answers, *, question="q", policy="solver", phase="construction", prefix=None):
    return tuple(
        SolverSample(
            f"{prefix or phase}/{question}/{index}",
            question,
            policy,
            phase,
            answer,
            f"trace/{prefix or phase}/{question}/{index}",
        )
        for index, answer in enumerate(answers)
    )


def cause(name, count=3, *, node="skill", state="active"):
    failures = tuple(f"old/{name}/{index}" for index in range(count))
    return Cause(
        name,
        node,
        "Reasoning cause " + name,
        state,
        failures if state == "active" else (),
        failures,
    )


def attribution(sample, value):
    return FailureAttribution(
        sample.sample_id,
        value.cause_id,
        value.node_id,
        value.description,
        ("diagnosis/" + sample.sample_id,),
    )


class VoteTests(unittest.TestCase):
    def test_double_confidence_rejects_conflict_easy_and_low_agreement_questions(self):
        policy = DiagEvoPolicy()
        accepted = policy.construction(samples("a" * 9 + "b" * 3))
        self.assertEqual((accepted.p1, accepted.p2), (0.75, 0.25))
        self.assertTrue(accepted.retained)
        self.assertEqual(accepted.label_source, "majority_vote")
        for answers in ("a" * 6 + "b" * 5 + "c", "a" * 12, "a" * 6 + "b" * 6, "aabcdefghijk"):
            with self.subTest(answers=answers):
                self.assertFalse(policy.construction(samples(answers)).retained)
        self.assertEqual(policy.construction(samples("a" * 12)).p2, 0)
        self.assertEqual(clone(policy).construction(accepted.samples), accepted)

    def test_construction_groups_reject_partial_repeated_or_cross_policy_responses(self):
        policy = DiagEvoPolicy()
        values = samples("a" * 9 + "b" * 3)
        bad = (
            values[:-1],
            values[:-1] + (values[0],),
            (replace(values[0], completed=False),) + values[1:],
            (replace(values[0], policy_id="another"),) + values[1:],
            (replace(values[0], question_id="other"),) + values[1:],
            (replace(values[0], answer_key=""),) + values[1:],
        )
        for rows in bad:
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "complete"):
                policy.construction(rows)

    def test_optimization_is_new_sampling_and_keeps_reference_even_if_all_responses_disagree(self):
        policy = DiagEvoPolicy()
        vote = policy.construction(samples("a" * 9 + "b" * 3))
        responses = samples("b" * 8, phase="optimization", policy="updated-solver")
        group = policy.optimization(vote, responses)
        self.assertEqual(group.rewards, (-1,) * 8)
        self.assertEqual(group.samples[0].policy_id, "updated-solver")
        reference = next(
            row for row in group.vote.samples if row.sample_id == vote.reference_sample_id
        )
        self.assertEqual(reference.answer_key, vote.answer_key)
        reused = (replace(responses[0], sample_id=vote.samples[0].sample_id),) + responses[1:]
        with self.assertRaisesRegex(ValueError, "new response"):
            policy.optimization(vote, reused)
        with self.assertRaisesRegex(ValueError, "construction evidence"):
            policy.optimization(replace(vote, answer_key="invented"), responses)
        easy = policy.construction(samples("a" * 12))
        with self.assertRaisesRegex(ValueError, "retained"):
            policy.optimization(easy, responses)


class ScheduleTests(unittest.TestCase):
    def test_frequencies_and_same_node_stitching_use_explicit_randomness(self):
        policy = DiagEvoPolicy()
        memory = (cause("a", 2), cause("b", 1, node="other"), cause("c", state="mastered"))
        self.assertEqual(policy.exploration_probability(memory, 6), 0.5)

        class Draws:
            def __init__(self, mode, chosen):
                self.mode, self.chosen = mode, chosen

            def value(self, key, index=0):
                return {
                    "diagevo/mode": self.mode,
                    "diagevo/cause": self.chosen,
                    "diagevo/sibling": 0.0,
                }[key]

        self.assertEqual(
            policy.schedule(memory, first_round_frequency=6, count=1, rng=Draws(0.9, 0)),
            (GenerationDirective("stitched", ("a", "c")),),
        )
        self.assertEqual(
            policy.schedule(memory, first_round_frequency=6, count=1, rng=Draws(0.9, 0.9)),
            (GenerationDirective("targeted", ("b",)),),
        )
        self.assertEqual(
            policy.schedule(memory, first_round_frequency=6, count=1, rng=Draws(0.1, 0)),
            (GenerationDirective("free"),),
        )
        rng = DeterministicRandom("round-1")
        self.assertEqual(
            policy.schedule(memory, first_round_frequency=6, count=100, rng=rng),
            policy.schedule(tuple(reversed(memory)), first_round_frequency=6, count=100, rng=rng),
        )
        self.assertEqual(
            policy.schedule((), first_round_frequency=0, count=2, rng=rng),
            (GenerationDirective("free"),) * 2,
        )
        with self.assertRaisesRegex(ValueError, "round-one"):
            policy.exploration_probability(memory, 0)
        with self.assertRaisesRegex(ValueError, "random"):
            policy.schedule(memory, first_round_frequency=6, count=1, rng=Draws(1.0, 0))


class MemoryTests(unittest.TestCase):
    def test_filtered_easy_candidates_promote_and_new_failures_reactivate_after_promotion(self):
        policy = DiagEvoPolicy()
        original = cause("a")
        easy = policy.construction(samples("a" * 12, question="easy"))
        hard = policy.construction(samples("a" * 9 + "b" * 3, question="hard"))
        group = policy.optimization(
            hard, samples("a" * 7 + "b", question="hard", phase="optimization")
        )
        generation = {name: GenerationDirective("targeted", ("a",)) for name in ("easy", "hard")}
        promoted = policy.update(
            (original,), votes=(easy, hard), generation=generation, groups=(), attributions=()
        )
        self.assertEqual((promoted[0].state, promoted[0].frequency), ("mastered", 0))
        revived = policy.update(
            (original,),
            votes=(easy, hard),
            generation=generation,
            groups=(group,),
            attributions=(attribution(group.samples[-1], original),),
        )
        self.assertEqual((revived[0].state, revived[0].frequency), ("active", 1))
        self.assertEqual(len(revived[0].failure_ids), 4)
        self.assertEqual(original.frequency, 3)
        # The rejected easy question alone is still valid promotion evidence.
        easy_only = policy.update(
            (original,),
            votes=(easy,),
            generation={"easy": generation["easy"]},
            groups=(),
            attributions=(),
        )
        self.assertEqual(easy_only[0].state, "mastered")

    def test_stitched_mastered_causes_can_reactivate_but_unobserved_causes_do_not_promote(self):
        policy = DiagEvoPolicy()
        active, mastered, untouched = (
            cause("a"),
            cause("b", state="mastered"),
            cause("c", node="other"),
        )
        vote = policy.construction(samples("a" * 9 + "b" * 3))
        group = policy.optimization(vote, samples("b" * 8, phase="optimization"))
        result = {
            item.cause_id: item
            for item in policy.update(
                (active, mastered, untouched),
                votes=(vote,),
                generation={"q": GenerationDirective("stitched", ("a", "b"))},
                groups=(group,),
                attributions=(attribution(group.samples[0], mastered),),
            )
        }
        self.assertEqual((result["a"].state, result["a"].frequency), ("mastered", 0))
        self.assertEqual((result["b"].state, result["b"].frequency), ("active", 1))
        self.assertEqual(result["c"], untouched)

    def test_new_causes_count_observed_failures_and_reject_duplicate_or_success_attribution(self):
        policy = DiagEvoPolicy()
        vote = policy.construction(samples("a" * 9 + "b" * 3))
        group = policy.optimization(vote, samples("b" * 7 + "a", phase="optimization"))
        new = cause("new")
        rows = tuple(attribution(sample, new) for sample in group.samples[:2])
        kwargs = dict(votes=(vote,), generation={"q": GenerationDirective("free")}, groups=(group,))
        result = policy.update((), attributions=rows, **kwargs)
        self.assertEqual(result[0].frequency, 2)
        self.assertEqual(result[0].failure_ids, tuple(row.sample_id for row in rows))
        for bad in (
            rows + (rows[0],),
            (attribution(group.samples[-1], new),),
            (replace(rows[0], evidence_refs=()),),
        ):
            with self.assertRaisesRegex(ValueError, "attributed once"):
                policy.update((), attributions=bad, **kwargs)
        with self.assertRaisesRegex(ValueError, "attributed once"):
            policy.update(result, attributions=rows, **kwargs)
        with self.assertRaisesRegex(ValueError, "reuse"):
            policy.update((), attributions=(), **{**kwargs, "groups": (group, group)})
        with self.assertRaisesRegex(ValueError, "complete round"):
            policy.update((), attributions=(), **{**kwargs, "generation": {}})


if __name__ == "__main__":
    unittest.main()
