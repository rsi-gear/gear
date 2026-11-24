"""Whole diagnostic rounds, persisted external-call recovery and evidence rejection."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from gear.training.contracts import TrainingConfig, TrainingContext
from gear.training.recipes import diagevo_round
from gear.training.recipes.diagevo import Cause, DiagEvoPolicy, GenerationDirective, SolverSample
from gear.training.recipes.diagevo_memory import SkillNode
from gear.training.recipes.diagevo_round import DiagEvoMemoryUpdater, RoundEvidence

A = "Confuses dependent events with independent events when combining conditional probability estimates"
B = "Omits relevant conditioning information when calculating event probabilities from correlated observations"
C = "Drops necessary boundary conditions when translating geometric relations into algebraic inequalities"
NEW = "Applies counting arguments without accounting for overlapping cases and repeated event membership"
VARIANT = "Counts overlapping cases repeatedly without subtracting shared members from the resulting total"
LABEL = (
    "Reason about conditional probability by tracking dependencies between events and sample spaces"
)
OTHER_LABEL = "Translate geometric constraints into algebraic relations while preserving boundaries and feasibility conditions"
NEW_LABEL = "Count distinct outcomes by separating overlapping collections and tracking shared membership correctly"
MERGED_LABEL = "Analyze reasoning constraints by preserving relevant conditions throughout each dependent mathematical transformation"


def evidence_fixture():
    policy = DiagEvoPolicy(construction_samples=4, optimization_group_size=2)
    memory = tuple(
        Cause(
            key,
            node,
            description,
            state,
            ("old/" + key,) if state == "active" else (),
            ("old/" + key,),
        )
        for key, node, description, state in (
            ("a", "a-node", A, "active"),
            ("b", "a-node", B, "mastered"),
            ("c", "b-node", C, "active"),
        )
    )
    nodes = (SkillNode("a-node", LABEL), SkillNode("b-node", OTHER_LABEL))
    votes, groups, texts = [], [], {}
    names = ("1-known", "2-new", "3-duplicate", "4-slip", "5-easy")
    for name in names:

        def samples(answers, phase):
            return tuple(
                SolverSample(
                    f"{phase}/{name}/{i}",
                    name,
                    "solver",
                    phase,
                    answer,
                    f"capture/{phase}/{name}/{i}",
                )
                for i, answer in enumerate(answers)
            )

        vote = policy.construction(samples("aaaa" if name == "5-easy" else "aaab", "construction"))
        votes.append(vote)
        if name != "5-easy":
            group = policy.optimization(vote, samples("ba", "optimization"))
            groups.append(group)
            texts[group.samples[0].trajectory_ref] = "Observed disagreement in " + name
            texts[vote.samples[0].trajectory_ref] = "Stored construction reference for " + name
    generation = {name: GenerationDirective("free") for name in names}
    generation["1-known"] = GenerationDirective("stitched", ("a", "b"))
    generation["5-easy"] = GenerationDirective("targeted", ("c",))
    evidence = RoundEvidence(
        tuple(votes), generation, tuple(groups), {name: "Question " + name for name in names}, texts
    )
    return policy, memory, nodes, evidence


class ExternalFixture:
    """Persisted test service. These records are explicitly fixtures, not LLM receipts."""

    def __init__(self, root, *, crash=None, before_submit=False):
        self.root = Path(root) / "external-fixture"
        self.root.mkdir(parents=True)
        self.crash, self.before_submit = crash, before_submit
        self.crashed = False
        self.unknown = False
        self.submissions, self.recoveries = [], []
        self.requests = []
        self.bad_description = False

    def finish(self, key, kind, label, output):
        if self.crash == label and not self.crashed and self.before_submit:
            self.crashed = True
            raise ConnectionError("fixture failed before submission")
        path = self.root / (key + ".json")
        if path.exists():
            raise AssertionError("duplicate external submission")
        path.write_text(json.dumps(output))
        self.submissions.append((key, kind, label))
        if self.crash == label and not self.crashed:
            self.crashed = True
            raise ConnectionError("fixture lost the completed acknowledgement")
        return output

    async def recover(self, key):
        self.recoveries.append(key)
        if self.unknown:
            return {"state": "unknown"}
        path = self.root / (key + ".json")
        return (
            {"state": "completed", "output": json.loads(path.read_text())}
            if path.exists()
            else {"state": "not_submitted"}
        )

    async def diagnose(self, key, request):
        self.requests.append(request)
        properties = request.schema["properties"]
        if "error_cause" in properties:
            question = request.data["question_id"]
            label = "extract/" + question
            output = {
                "matched_cause_id": "b" if question == "1-known" else None,
                "error_cause": ("short" if self.bad_description else NEW)
                if question == "2-new"
                else VARIANT
                if question == "3-duplicate"
                else None,
            }
        elif "duplicate" in properties:
            label = "deduplicate"
            candidate = next(row for row in request.data["candidates"] if row["description"] == NEW)
            output = {"duplicate": True, "matched_cause_id": candidate["cause_id"]}
        elif "create_new_node" in properties:
            label = "assign"
            output = {"create_new_node": True, "new_node_label": NEW_LABEL, "assigned_node": None}
        else:
            label = "merge"
            output = {"merge": True, "merged_label": MERGED_LABEL}
        return self.finish(key, "diagnosis", label, output)

    async def embed(self, key, text):
        if text in (NEW, VARIANT):
            vector = [-1.0, 0.0]
        elif text in (C, NEW_LABEL):
            vector = [0.0, 1.0]
        else:
            vector = [1.0, 0.0]
        return self.finish(key, "embedding", "embed/" + text, vector)


def context(root):
    path = Path(root)
    return TrainingContext(
        1,
        {"solver": "updated-policy", "challenger": "frozen-policy"},
        [],
        "round-operation",
        path / "stage",
        path,
        TrainingConfig(path, 2, parameters={"seed": "test"}),
    )


def updater(service, policy, **kwargs):
    return DiagEvoMemoryUpdater(
        diagnose=service.diagnose,
        embed=service.embed,
        recover_diagnosis=service.recover,
        recover_embedding=service.recover,
        diagnosis_identity={"model": "diagnosis-fixture", "version": 1},
        embedding_identity={"model": "embedding-fixture", "version": 1},
        policy=policy,
        **kwargs,
    )


class WholeRoundTests(unittest.TestCase):
    def run_round(self, caller, ctx, evidence, memory, nodes):
        return asyncio.run(caller.update(ctx, evidence, memory=memory, nodes=nodes))

    def assert_result(self, result):
        by_id = {value["cause_id"]: value for value in result["memory"]}
        self.assertEqual((by_id["a"]["state"], by_id["c"]["state"]), ("mastered", "mastered"))
        self.assertEqual(by_id["b"]["state"], "active")
        self.assertEqual(len(by_id["b"]["episode_failure_ids"]), 1)
        self.assertEqual(len(by_id["b"]["failure_ids"]), 2)
        added = [row for key, row in by_id.items() if key not in ("a", "b", "c")]
        self.assertEqual(len(added), 1)
        self.assertEqual(len(added[0]["episode_failure_ids"]), 2)
        self.assertEqual(len(added[0]["failure_ids"]), 2)
        self.assertEqual(by_id["c"]["node_id"], "a-node")
        self.assertEqual(len(result["nodes"]), 2)
        self.assertEqual(len(result["attributions"]), 3)
        self.assertEqual(result["unattributed_sample_ids"], ["optimization/4-slip/0"])

    def test_complete_round_deduplicates_new_causes_promotes_reactivates_and_consolidates(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service = ExternalFixture(root)
            caller, ctx = updater(service, policy), context(root)
            result = self.run_round(caller, ctx, evidence, memory, nodes)
            self.assert_result(result)
            self.assertEqual(sum(kind == "diagnosis" for _, kind, _ in service.submissions), 7)
            embeddings = [label for _, kind, label in service.submissions if kind == "embedding"]
            self.assertEqual(len(embeddings), len(set(embeddings)))
            prior = list(service.submissions)
            self.assertEqual(caller.verify(ctx.workspace, operation_id=ctx.operation_id), result)
            # A new updater instance reconstructs from records, not Python attributes.
            self.assertEqual(
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes), result
            )
            self.assertEqual(service.submissions, prior)
            self.assertFalse(service.recoveries)
            self.assertEqual(memory[0].state, "active")

    def test_recovery_after_extraction_embedding_assignment_and_merge_never_resubmits(self):
        for crash in ("extract/2-new", "embed/" + NEW, "assign", "merge"):
            with self.subTest(crash=crash), tempfile.TemporaryDirectory() as root:
                policy, memory, nodes, evidence = evidence_fixture()
                service = ExternalFixture(root, crash=crash)
                ctx = context(root)
                with self.assertRaises(ConnectionError):
                    self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
                self.assertFalse((ctx.workspace / "diagevo-memory/result.json").exists())
                result = self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
                self.assert_result(result)
                keys = [key for key, _, _ in service.submissions]
                self.assertEqual(len(keys), len(set(keys)))
                self.assertEqual(len(service.recoveries), 1)

    def test_unknown_outcome_stops_until_original_result_is_recoverable(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service = ExternalFixture(root, crash="extract/1-known")
            ctx = context(root)
            with self.assertRaises(ConnectionError):
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            service.unknown = True
            with self.assertRaisesRegex(RuntimeError, "unknown external outcome"):
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            self.assertEqual(len(service.submissions), 1)
            service.unknown = False
            self.assert_result(
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            )

    def test_authoritatively_not_submitted_intent_can_be_executed_once(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service = ExternalFixture(root, crash="extract/1-known", before_submit=True)
            ctx = context(root)
            with self.assertRaises(ConnectionError):
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            self.assertFalse(service.submissions)
            self.assert_result(
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            )
            self.assertEqual(len(service.recoveries), 1)

    def test_lost_final_acknowledgement_replays_without_reapplying_state_changes(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service, ctx = ExternalFixture(root), context(root)
            original = diagevo_round._freeze

            def fail_after_commit(path, value):
                original(path, value)
                if path == ctx.workspace / "diagevo-memory/result.json":
                    raise ConnectionError("lost memory-commit acknowledgement")

            with patch.object(diagevo_round, "_freeze", fail_after_commit):
                with self.assertRaisesRegex(ConnectionError, "memory-commit"):
                    self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            count = len(service.submissions)
            self.assert_result(
                self.run_round(updater(service, policy), ctx, evidence, memory, nodes)
            )
            self.assertEqual(len(service.submissions), count)

    def test_concurrent_round_owner_is_rejected_before_duplicate_submission(self):
        async def run(root):
            policy, memory, nodes, evidence = evidence_fixture()
            service, ctx = ExternalFixture(root), context(root)
            entered, release = asyncio.Event(), asyncio.Event()
            first = updater(service, policy)
            original = first.diagnose

            async def held(key, request):
                entered.set()
                await release.wait()
                return await original(key, request)

            first.diagnose = held
            task = asyncio.create_task(first.update(ctx, evidence, memory=memory, nodes=nodes))
            await entered.wait()
            try:
                with self.assertRaises(BlockingIOError):
                    await updater(service, policy).update(ctx, evidence, memory=memory, nodes=nodes)
                self.assertFalse(service.submissions)
            finally:
                release.set()
            self.assert_result(await task)

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(run(root))

    def test_alias_captures_hidden_text_and_reused_failures_fail_before_external_calls(self):
        policy, memory, nodes, evidence = evidence_fixture()
        first, second = evidence.groups[:2]
        sample = replace(second.samples[0], trajectory_ref=first.samples[0].trajectory_ref)
        aliased = replace(
            evidence,
            groups=(
                first,
                replace(second, samples=(sample, second.samples[1])),
                *evidence.groups[2:],
            ),
        )
        extra = replace(
            evidence, trajectory_texts={**evidence.trajectory_texts, "hidden/test": "Not permitted"}
        )
        missing_question = replace(evidence, questions={})
        for value in (aliased, extra, missing_question):
            with tempfile.TemporaryDirectory() as root, self.subTest(value=value):
                service = ExternalFixture(root)
                with self.assertRaises(ValueError):
                    self.run_round(updater(service, policy), context(root), value, memory, nodes)
                self.assertFalse(service.submissions)
        with tempfile.TemporaryDirectory() as root:
            service = ExternalFixture(root)
            known = replace(memory[1], failure_ids=("optimization/1-known/0",))
            with self.assertRaisesRegex(ValueError, "previous failure"):
                self.run_round(
                    updater(service, policy),
                    context(root),
                    evidence,
                    (memory[0], known, memory[2]),
                    nodes,
                )
            self.assertFalse(service.submissions)

    def test_configuration_drift_and_missing_completed_evidence_never_trigger_more_calls(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service, ctx = ExternalFixture(root), context(root)
            caller = updater(service, policy)
            self.run_round(caller, ctx, evidence, memory, nodes)
            original = len(service.submissions)
            changed = replace(
                evidence, questions={**evidence.questions, "2-new": "changed question"}
            )
            with self.assertRaisesRegex(ValueError, "frozen DiagEvo"):
                self.run_round(caller, ctx, changed, memory, nodes)
            drifted = updater(service, policy)
            drifted.embedding_identity["version"] = 2
            with self.assertRaisesRegex(ValueError, "frozen DiagEvo"):
                self.run_round(drifted, ctx, evidence, memory, nodes)
            path = next((ctx.workspace / "diagevo-memory/calls").glob("*/result.json"))
            path.unlink()
            with self.assertRaisesRegex(ValueError, "missing, changed or extra"):
                caller.verify(ctx.workspace, operation_id=ctx.operation_id)
            with self.assertRaisesRegex(ValueError, "missing, changed or extra"):
                self.run_round(caller, ctx, evidence, memory, nodes)
            self.assertEqual(len(service.submissions), original)

    def test_budget_and_invalid_completed_response_do_not_silently_retry(self):
        with tempfile.TemporaryDirectory() as root:
            policy, memory, nodes, evidence = evidence_fixture()
            service, ctx = ExternalFixture(root), context(root)
            caller = updater(service, policy, max_diagnoses=1)
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "budget exhausted"):
                    self.run_round(caller, ctx, evidence, memory, nodes)
            self.assertEqual(len(service.submissions), 1)
        with tempfile.TemporaryDirectory() as root:
            service, ctx = ExternalFixture(root), context(root)
            service.bad_description = True
            caller = updater(service, policy)
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "10–20 words"):
                    self.run_round(caller, ctx, evidence, memory, nodes)
            self.assertEqual(len(service.submissions), 2)
            self.assertFalse((ctx.workspace / "diagevo-memory/result.json").exists())

    def test_overlapping_node_pairs_use_updated_members_without_inferred_transitive_merges(self):
        with tempfile.TemporaryDirectory() as root:
            service = ExternalFixture(root)
            policy = DiagEvoPolicy()
            memory = tuple(
                Cause(key, key, A, "active", ("old/" + key,), ("old/" + key,))
                for key in ("a", "b", "c")
            )
            nodes = tuple(SkillNode(key, LABEL) for key in ("a", "b", "c"))
            result = self.run_round(
                updater(service, policy),
                context(root),
                RoundEvidence((), {}, (), {}, {}),
                memory,
                nodes,
            )
            self.assertEqual(len(result["nodes"]), 1)
            merges = [
                request for request in service.requests if "merge" in request.schema["properties"]
            ]
            self.assertEqual(len(merges), 2)
            self.assertEqual(sum(len(node["causes"]) for node in merges[1].data["nodes"]), 3)
            self.assertEqual(
                [len(row["episode_failure_ids"]) for row in result["memory"]], [1, 1, 1]
            )


if __name__ == "__main__":
    unittest.main()
