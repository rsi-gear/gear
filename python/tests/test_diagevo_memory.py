"""Diagnostic routing tests with explicit vectors and model decisions, not fake LLM evidence."""

import math
import unittest
from dataclasses import replace

from gear.core import clone
from gear.core.schema import validate_schema
from gear.training.recipes.diagevo import (
    Cause,
    DiagEvoPolicy,
    FailureAttribution,
    GenerationDirective,
    SolverSample,
)
from gear.training.recipes.diagevo_memory import (
    DiagEvoDiagnostician,
    DiagnosisPair,
    SkillNode,
)

DESCRIPTION = "Confuses dependent events with independent events when combining conditional probability estimates"
NEW_CAUSE = "Applies counting arguments without accounting for overlapping cases and repeated event membership"
LABEL = (
    "Reason about conditional probability by tracking dependencies between events and sample spaces"
)
OTHER_LABEL = "Translate geometric constraints into algebraic relations while preserving boundaries and feasibility conditions"


def cause(key, node="skill", *, mastered=False):
    ids = (f"old/{key}/1", f"old/{key}/2")
    return Cause(
        key, node, DESCRIPTION, "mastered" if mastered else "active", () if mastered else ids, ids
    )


def group(policy):
    def responses(answers, phase):
        return tuple(
            SolverSample(f"{phase}/{i}", "q", "solver", phase, answer, f"capture/{phase}/{i}")
            for i, answer in enumerate(answers)
        )

    return policy.optimization(
        policy.construction(responses("aaab", "construction")),
        responses("bb", "optimization"),
    )


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.policy = DiagEvoPolicy(construction_samples=4, optimization_group_size=2)
        self.diagnoser = DiagEvoDiagnostician()
        self.memory = (cause("active"), cause("mastered", mastered=True))
        self.group = group(self.policy)
        self.pair = DiagnosisPair(
            self.group,
            self.group.samples[0].sample_id,
            "A probability question",
            "Construction reference reasoning",
            "Different optimization reasoning",
            GenerationDirective("stitched", ("active", "mastered")),
        )

    def test_all_failed_optimization_uses_stored_construction_reference_and_known_recurrence(self):
        request = self.diagnoser.prepare_extraction(
            self.pair, policy=self.policy, memory=self.memory
        )
        validate_schema(request.schema)
        self.assertEqual(request.data["label_source"], "majority_vote")
        self.assertEqual(request.data["reference"]["sample"]["sample_id"], "construction/0")
        self.assertEqual(request.data["failure"]["sample"]["phase"], "optimization")
        self.assertEqual(
            [row["cause_id"] for row in request.data["known_causes"]], ["active", "mastered"]
        )
        diagnosis = self.diagnoser.parse_extraction(
            {"matched_cause_id": "mastered", "error_cause": None},
            pair=self.pair,
            policy=self.policy,
            memory=self.memory,
        )
        self.assertEqual(diagnosis.matched_cause_id, "mastered")
        self.assertEqual(
            diagnosis.evidence_refs, ("capture/optimization/0", "capture/construction/0")
        )
        # This diagnostic decision can feed the existing joint transition directly.
        target = self.memory[1]
        updated = self.policy.update(
            self.memory,
            votes=(self.group.vote,),
            generation={"q": self.pair.generation},
            groups=(self.group,),
            attributions=(
                FailureAttribution(
                    diagnosis.sample_id,
                    target.cause_id,
                    target.node_id,
                    target.description,
                    diagnosis.evidence_refs,
                ),
            ),
        )
        revived = next(value for value in updated if value.cause_id == "mastered")
        self.assertEqual(
            (revived.state, revived.frequency, len(revived.failure_ids)), ("active", 1, 3)
        )
        self.assertEqual(
            clone(self.diagnoser).prepare_extraction(
                self.pair,
                policy=self.policy,
                memory=self.memory,
            ),
            request,
        )

    def test_extraction_does_not_invent_known_causes_or_force_non_skill_failures(self):
        free = replace(self.pair, generation=GenerationDirective("free"))
        for description in (None, NEW_CAUSE):
            diagnosis = self.diagnoser.parse_extraction(
                {"matched_cause_id": None, "error_cause": description},
                pair=free,
                policy=self.policy,
                memory=self.memory,
            )
            self.assertEqual(diagnosis.error_cause, description)
        for response in (
            {"matched_cause_id": "active", "error_cause": None},
            {"matched_cause_id": None, "error_cause": "too brief"},
            {"matched_cause_id": None, "error_cause": "word " * 21},
        ):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.diagnoser.parse_extraction(
                    response, pair=free, policy=self.policy, memory=self.memory
                )
        with self.assertRaisesRegex(ValueError, "both match"):
            self.diagnoser.parse_extraction(
                {"matched_cause_id": "active", "error_cause": NEW_CAUSE},
                pair=self.pair,
                policy=self.policy,
                memory=self.memory,
            )
        targeted = replace(self.pair, generation=GenerationDirective("targeted", ("active",)))
        with self.assertRaises(ValueError):
            self.diagnoser.parse_extraction(
                {"matched_cause_id": "mastered", "error_cause": None},
                pair=targeted,
                policy=self.policy,
                memory=self.memory,
            )

    def test_extraction_rejects_altered_group_successes_and_invalid_generation(self):
        successful = self.policy.optimization(
            self.group.vote,
            (replace(self.group.samples[0], answer_key="a"), self.group.samples[1]),
        )
        bad_pairs = (
            replace(self.pair, group=replace(self.group, rewards=(1, -1))),
            replace(self.pair, group=successful),
            replace(self.pair, reference_text=""),
            replace(self.pair, failed_text=None),
            replace(self.pair, generation=GenerationDirective("stitched", ("mastered", "active"))),
            replace(self.pair, generation=GenerationDirective("free", ("active",))),
        )
        for pair in bad_pairs:
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                self.diagnoser.prepare_extraction(pair, policy=self.policy, memory=self.memory)


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.diagnoser = DiagEvoDiagnostician(top_k=2)
        self.memory = (
            cause("a", "one"),
            cause("b", "one", mastered=True),
            cause("c", "two"),
            cause("d", "three"),
        )
        self.nodes = tuple(SkillNode(key, LABEL) for key in ("one", "two", "three"))
        self.scores = {"a": -0.9, "b": 0.9, "c": 0.8, "d": 0.5}

    def test_cosine_is_complete_order_invariant_and_numerically_finite(self):
        vectors = {"a": (-1.0, 0.0), "b": (1e308, 0.0), "c": (0.0, 2.0), "d": (1.0, 1.0)}
        scores = self.diagnoser.cause_similarities(
            self.memory, query_embedding=(1e308, 0.0), cause_embeddings=vectors
        )
        self.assertEqual((scores["a"], scores["b"], scores["c"]), (-1, 1, 0))
        self.assertAlmostEqual(scores["d"], 1 / math.sqrt(2))
        self.assertEqual(
            scores,
            self.diagnoser.cause_similarities(
                tuple(reversed(self.memory)),
                query_embedding=(2.0, 0.0),
                cause_embeddings=vectors,
            ),
        )
        for bad in ((0.0, 0.0), (1.0,), (math.nan, 0.0), (True, 1.0)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.diagnoser.cause_similarities(
                    self.memory, query_embedding=bad, cause_embeddings=vectors
                )
        with self.assertRaisesRegex(ValueError, "exact cause memory"):
            self.diagnoser.cause_similarities(
                self.memory, query_embedding=(1.0, 0.0), cause_embeddings={"a": (1.0, 0.0)}
            )

    def test_duplicate_screening_needs_semantic_confirmation_and_can_reactivate_mastered(self):
        request = self.diagnoser.prepare_deduplication(
            NEW_CAUSE, memory=self.memory, similarities=self.scores
        )
        validate_schema(request.schema)
        self.assertEqual([row["cause_id"] for row in request.data["candidates"]], ["b", "c"])
        self.assertIsNone(
            self.diagnoser.parse_deduplication(
                {"duplicate": False, "matched_cause_id": None},
                description=NEW_CAUSE,
                memory=self.memory,
                similarities=self.scores,
            )
        )
        matched = self.diagnoser.parse_deduplication(
            {"duplicate": True, "matched_cause_id": "b"},
            description=NEW_CAUSE,
            memory=self.memory,
            similarities=self.scores,
        )
        self.assertEqual(matched, self.memory[1])
        for response in (
            {
                "duplicate": True,
                "matched_cause_id": "d",
            },  # Exactly at the threshold is not above it.
            {"duplicate": True, "matched_cause_id": None},
            {"duplicate": False, "matched_cause_id": "b"},
        ):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.diagnoser.parse_deduplication(
                    response, description=NEW_CAUSE, memory=self.memory, similarities=self.scores
                )
        with self.assertRaisesRegex(ValueError, "proceed directly"):
            self.diagnoser.prepare_deduplication(
                NEW_CAUSE, memory=self.memory, similarities={key: 0.5 for key in self.scores}
            )
        with self.assertRaisesRegex(ValueError, "exact memory"):
            self.diagnoser.prepare_deduplication(
                NEW_CAUSE, memory=self.memory, similarities={"a": 0.99}
            )

    def test_node_shortlist_uses_best_member_not_mean_and_limits_assignment(self):
        request = self.diagnoser.prepare_assignment(
            NEW_CAUSE, nodes=self.nodes, memory=self.memory, similarities=self.scores
        )
        validate_schema(request.schema)
        rows = request.data["candidates"]
        self.assertEqual([row["node"]["node_id"] for row in rows], ["one", "two"])
        self.assertEqual(rows[0]["representative"]["cause_id"], "b")
        selected = self.diagnoser.parse_assignment(
            {"create_new_node": False, "new_node_label": None, "assigned_node": "one"},
            description=NEW_CAUSE,
            nodes=self.nodes,
            memory=self.memory,
            similarities=self.scores,
        )
        self.assertEqual(selected, self.nodes[0])
        for response in (
            {"create_new_node": False, "new_node_label": None, "assigned_node": "three"},
            {"create_new_node": False, "new_node_label": LABEL, "assigned_node": "one"},
            {"create_new_node": True, "new_node_label": LABEL, "assigned_node": "one"},
        ):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.diagnoser.parse_assignment(
                    response,
                    description=NEW_CAUSE,
                    nodes=self.nodes,
                    memory=self.memory,
                    similarities=self.scores,
                )

    def test_empty_memory_creates_one_new_node_with_a_caller_owned_identity(self):
        response = {"create_new_node": True, "new_node_label": LABEL, "assigned_node": None}
        node = self.diagnoser.parse_assignment(
            response,
            description=NEW_CAUSE,
            nodes=(),
            memory=(),
            similarities={},
            new_node_id="fresh",
        )
        self.assertEqual(node, SkillNode("fresh", LABEL))
        with self.assertRaisesRegex(ValueError, "fresh node identity"):
            self.diagnoser.parse_assignment(
                response, description=NEW_CAUSE, nodes=(), memory=(), similarities={}
            )
        with self.assertRaisesRegex(ValueError, "fresh node identity"):
            self.diagnoser.parse_assignment(
                response,
                description=NEW_CAUSE,
                nodes=self.nodes,
                memory=self.memory,
                similarities=self.scores,
                new_node_id="one",
            )
        with self.assertRaisesRegex(ValueError, "every node"):
            self.diagnoser.prepare_assignment(
                NEW_CAUSE, nodes=self.nodes[:-1], memory=self.memory, similarities=self.scores
            )


class ConsolidationTests(unittest.TestCase):
    def test_merge_preserves_every_cause_identity_history_and_active_episode(self):
        diagnoser = DiagEvoDiagnostician()
        nodes = (SkillNode("z", LABEL), SkillNode("a", OTHER_LABEL), SkillNode("keep", LABEL))
        memory = (cause("x", "z"), cause("y", "a", mastered=True), cause("unrelated", "keep"))
        pairs = diagnoser.merge_candidates(
            nodes, memory=memory, node_embeddings={"z": (2, 0), "a": (1, 0), "keep": (0, 1)}
        )
        self.assertEqual(pairs, (("a", "z"),))
        request = diagnoser.prepare_consolidation("z", "a", nodes=nodes, memory=memory)
        validate_schema(request.schema)
        self.assertEqual([row["node"]["node_id"] for row in request.data["nodes"]], ["a", "z"])
        self.assertEqual(len(request.data["nodes"][0]["causes"]), 1)
        unchanged_nodes, unchanged_causes = diagnoser.parse_consolidation(
            {"merge": False, "merged_label": None},
            left="z",
            right="a",
            nodes=nodes,
            memory=memory,
        )
        self.assertEqual(set(unchanged_nodes), set(nodes))
        self.assertEqual(set(unchanged_causes), set(memory))
        updated_nodes, updated_causes = diagnoser.parse_consolidation(
            {"merge": True, "merged_label": LABEL},
            left="z",
            right="a",
            nodes=nodes,
            memory=memory,
        )
        self.assertEqual({node.node_id for node in updated_nodes}, {"a", "keep"})
        by_id = {value.cause_id: value for value in updated_causes}
        for old in memory:
            self.assertEqual(
                by_id[old.cause_id], replace(old, node_id="a") if old.node_id == "z" else old
            )
        self.assertEqual(memory[0].node_id, "z")
        # A response for a removed node cannot be applied again to the new memory.
        with self.assertRaisesRegex(ValueError, "distinct existing"):
            diagnoser.parse_consolidation(
                {"merge": True, "merged_label": LABEL},
                left="z",
                right="a",
                nodes=updated_nodes,
                memory=updated_causes,
            )
        for response in (
            {"merge": False, "merged_label": LABEL},
            {"merge": True, "merged_label": "short"},
        ):
            with self.subTest(response=response), self.assertRaises(ValueError):
                diagnoser.parse_consolidation(
                    response, left="z", right="a", nodes=nodes, memory=memory
                )

    def test_merge_screening_rejects_missing_nonfinite_and_mismatched_embeddings(self):
        diagnoser = DiagEvoDiagnostician()
        nodes = (SkillNode("a", LABEL), SkillNode("b", LABEL))
        memory = (cause("x", "a"), cause("y", "b"))
        for vectors in ({"a": (1, 0)}, {"a": (1, 0), "b": (math.inf, 0)}, {"a": (1, 0), "b": (1,)}):
            with self.subTest(vectors=vectors), self.assertRaises(ValueError):
                diagnoser.merge_candidates(nodes, memory=memory, node_embeddings=vectors)
        for bad in (
            DiagEvoDiagnostician(top_k=True),
            DiagEvoDiagnostician(merge_threshold=math.nan),
        ):
            with self.assertRaises(ValueError):
                bad.merge_candidates(
                    nodes, memory=memory, node_embeddings={"a": (1, 0), "b": (1, 0)}
                )


if __name__ == "__main__":
    unittest.main()
