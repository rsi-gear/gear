"""Solver batch/commit fixtures reaching the real memory workflow, without model training."""

import asyncio
import copy
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path

import test_diagevo_data
from gear.training.contracts import TrainingConfig, TrainingContext
from gear.training.recipes.diagevo import Cause, DiagEvoPolicy, GenerationDirective
from gear.training.recipes.diagevo_memory import SkillNode
from gear.training.recipes.diagevo_round import DiagEvoMemoryUpdater
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.runtime.preflight import compatibility_digest
from gear.training.storage.content import ContractError, digest_json

CAUSE = "Check boundary conditions before simplifying expressions with sign dependent algebraic transformations"
NODE = "Apply valid algebraic transformations while preserving expression domains and boundary conditions"


class SolverBatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_diagevo_data.NativeRewardTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store, self.fixed = self.fixture.store, self.fixture.fixed
        self.request = copy.deepcopy(self.fixture.request)
        self.request.update(
            trainingRunId="train-solver",
            referenceModelRef=self.fixed,
            trainingDevices=[{"nodeId": "cpu-contract-fixture", "gpuUuid": "not-a-real-gpu"}],
            deployment={"kind": "cpu-contract-fixture"},
        )
        self.request["parentModel"].update(
            architecture="fixture",
            dtype="float32",
            hfSnapshotRef=self.fixed,
        )
        self.request["trainer"].update(
            backend="slime",
            runtimeLock={"kind": "cpu-contract-fixture"},
            hyperparametersRef=self.fixed,
            updatesPerCandidate=2,
        )
        self.questions = {"keep": "What is the first answer?", "easy": "What is the easy answer?"}
        self.request["trainDataset"]["tasks"] = [
            {"id": key, "taskRef": self.fixed, "environmentRef": self.fixed}
            for key in self.questions
        ]
        self.policy = DiagEvoPolicy(optimization_group_size=2)
        self.builder = DiagEvoSolverDatasetBuilder(self.store, self.request, policy=self.policy)
        self.memory = (Cause("cause", "node", CAUSE, "active", ("old",), ("old",)),)
        self.generation = {
            key: GenerationDirective("targeted", ("cause",)) for key in self.questions
        }
        self.construction, labels = {}, []
        for key, question in self.questions.items():
            answers = "a" * 9 + "b" * 3 if key == "keep" else "a" * 12
            rows = tuple(
                self.capture(f"construction/{key}/{i}", key, "answer " + answer, slot=i)
                for i, answer in enumerate(answers)
            )
            self.construction[key] = rows
            labels.extend(self.labels(rows, answers))
        self.classification = self.classify(labels)
        self.pool = self.seal_pool()

    def capture(self, name, question_id, response, *, slot, step=None, policy=None):
        raw = self.fixture.capture(
            name,
            self.questions[question_id],
            response,
            solver=True,
            slot=slot,
            policy=policy or ("solver-v1" if step is None else f"solver-step-{step}"),
        )
        context = self.store.read_json(raw.context_ref)
        context.update(taskId=question_id, groupId=f"group/{step}/{question_id}")
        if step is not None:
            context["batchId"] = f"batch-{step}"
        episode = self.store.read_json(raw.episode_ref)
        episode["groupId"] = context["groupId"]
        receipt = self.store.read_json(raw.receipt_refs[0])
        receipt["taskId"] = question_id
        return replace(
            raw,
            context_ref=self.store.put_json(context),
            episode_ref=self.store.put_json(episode),
            receipt_refs=[self.store.put_json(receipt)],
        )

    def labels(self, raws, answers):
        return [
            {
                "trajectoryDigest": digest_json(asdict(raw)),
                "answerKey": answer,
                "evidenceRef": self.fixed,
            }
            for raw, answer in zip(raws, answers, strict=True)
        ]

    def classify(self, labels, *, pool=None):
        return self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-answer-classes"
                if pool is None
                else "diagevo-optimization-classes",
                "classifier": {"kind": "cpu-fixture-stable-answer-keys", "version": 1},
                "labels": labels,
                **({"curriculumRef": pool} if pool is not None else {}),
            }
        )

    def seal_pool(self, **changes):
        kwargs = dict(
            generation=self.generation,
            memory=self.memory,
            construction_policy_id="solver-v1",
            answer_classes_ref=self.classification,
        )
        kwargs.update(changes)
        return self.builder.seal_curriculum(self.questions, self.construction, **kwargs)

    def batch(self, step, before, *, answers="bb", question="keep", empty=False, prefix="opt"):
        raws = tuple(
            self.capture(
                f"{prefix}/{step}/{index}",
                question,
                "" if empty and index == 0 else "answer " + answer,
                slot=index,
                step=step,
            )
            for index, answer in enumerate(answers)
        )
        lease = {
            **self.fixture.lease,
            "trainingRunId": "train-solver",
            "batchId": f"batch-{step}",
            "policyVersion": f"solver-step-{step}",
            "runtimeInstanceId": "solver-runtime",
            "synchronizedWeightsRef": before,
        }
        labels = self.classify(self.labels(raws, answers), pool=self.pool)
        ref = self.builder.build(
            (raws,), lease=lease, curriculum_ref=self.pool, answer_classes_ref=labels
        )
        return ref, raws, lease, labels

    def commit(self, batch_ref, number, previous=None):
        # Explicit fixture manifests exercise commit joins. No GPU execution or
        # optimizer update is represented by these small stored JSON objects.
        actor = self.store.put_json({"kind": "cpu-state-fixture", "number": number})
        exported = self.store.put_json({"weightsDigest": digest_json(["cpu-fixture", number])})
        cursor = self.store.put_json(
            {"committedUpdate": number, "batchRef": batch_ref, "groupResamples": 0}
        )
        checkpoint = self.store.put_json(
            {
                "schemaVersion": 1,
                "committedUpdate": number,
                "actorStateRef": actor,
                "optimizerStateRef": actor,
                "schedulerAndRngRef": actor,
                "hfExportRef": exported,
                "actorWeightsDigest": self.store.read_json(exported)["weightsDigest"],
                "dataCursorRef": cursor,
                "compatibilityDigest": compatibility_digest(self.request),
            }
        )
        ref = self.store.put_json(
            {
                "schemaVersion": 1,
                "trainingRunId": self.request["trainingRunId"],
                "committedUpdate": number,
                "consumedBatchDigest": batch_ref["digest"],
                "checkpointRef": checkpoint,
                "dataCursorRef": cursor,
                "rngRef": actor,
                **({"previousCommitRef": previous} if previous is not None else {}),
            }
        )
        return ref, exported

    def job(self, *, empty=False):
        first, raws, _, _ = self.batch(0, self.fixed, empty=empty)
        c1, exported = self.commit(first, 1)
        second, _, _, _ = self.batch(1, exported, answers="ab")
        c2, _ = self.commit(second, 2, c1)
        return (c1, c2), first, raws

    def test_filtered_questions_remain_in_pool_but_cannot_enter_solver_gradient_batch(self):
        pool = self.store.read_json(self.pool)
        self.assertEqual(
            {row["question_id"]: row["retained"] for row in pool["votes"]},
            {"easy": False, "keep": True},
        )
        self.assertEqual(set(pool["input"]["generation"]), {"keep", "easy"})
        with self.assertRaisesRegex(ContractError, "retained by double confidence"):
            self.batch(0, self.fixed, question="easy")
        self.assertEqual(self.seal_pool(), self.pool)

    def test_all_failed_native_groups_keep_original_tokens_and_stored_construction_reference(self):
        commits, batch_ref, raws = self.job()
        batch = self.store.read_json(batch_ref)
        samples = self.store.read_json(batch["samplesRef"])[0]
        self.assertEqual([row["reward"] for row in samples], [-1, -1])
        for row, raw in zip(samples, raws, strict=True):
            receipt = self.store.read_json(raw.receipt_refs[0])
            self.assertEqual(
                row["tokens"],
                self.store.read_json(receipt["inputTokenIdsRef"])
                + self.store.read_json(receipt["outputTokenIdsRef"]),
            )
            self.assertEqual(
                row["rollout_log_probs"], self.store.read_json(receipt["behaviorLogProbsRef"])
            )
            self.assertEqual(row["metadata"]["originalVerifierReward"], 7)
        evidence = self.builder.round_evidence(commits, curriculum_ref=self.pool)
        self.assertEqual(len(evidence.groups), 2)
        self.assertEqual(evidence.groups[0].rewards, (-1, -1))
        self.assertEqual(evidence.groups[1].rewards, (1, -1))
        self.assertEqual(set(evidence.questions), {"easy", "keep"})
        self.assertEqual(len(evidence.trajectory_texts), 4)
        self.assertEqual(self.builder.round_evidence(commits, curriculum_ref=self.pool), evidence)

    def test_committed_failures_reach_memory_and_empty_responses_remain_observed_empty(self):
        commits, _, _ = self.job(empty=True)
        evidence = self.builder.round_evidence(commits, curriculum_ref=self.pool)
        self.assertIn("", evidence.trajectory_texts.values())
        requests, completed = [], {}

        async def diagnose(key, request):
            requests.append(request)
            value = {
                "matched_cause_id": "cause" if request.data["failure"]["text"] else None,
                "error_cause": None,
            }
            completed[key] = value
            return value

        async def embed(key, text):
            raise AssertionError("known recurrences in one node need no embedding call")

        async def recover(key):
            return (
                {"state": "completed", "output": completed[key]}
                if key in completed
                else {"state": "not_submitted"}
            )

        updater = DiagEvoMemoryUpdater(
            diagnose=diagnose,
            embed=embed,
            recover_diagnosis=recover,
            recover_embedding=recover,
            diagnosis_identity={"kind": "cpu-fixture", "version": 1},
            embedding_identity={"kind": "unused-cpu-fixture", "version": 1},
            policy=self.policy,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = self.store.read_json(commits[-1])["checkpointRef"]
            context = TrainingContext(
                0,
                checkpoint,
                [],
                "fixture-memory-round",
                root / "stage",
                root,
                TrainingConfig(root, 1),
            )
            result = asyncio.run(
                updater.update(
                    context, evidence, memory=self.memory, nodes=(SkillNode("node", NODE),)
                )
            )
            repeated = asyncio.run(
                updater.update(
                    context, evidence, memory=self.memory, nodes=(SkillNode("node", NODE),)
                )
            )
        self.assertEqual(result, repeated)
        self.assertEqual(len(requests), 3)
        self.assertEqual(result["memory"][0]["state"], "active")
        self.assertEqual(len(result["memory"][0]["episode_failure_ids"]), 2)
        self.assertEqual(result["unattributed_sample_ids"], ["opt/0/0"])

    def test_native_commit_chain_cannot_omit_reorder_or_substitute_unconsumed_batches(self):
        commits, _, _ = self.job()
        for values in ((commits[0],), tuple(reversed(commits)), (commits[0], commits[0])):
            with self.subTest(values=values), self.assertRaises(ContractError):
                self.builder.round_evidence(values, curriculum_ref=self.pool)
        unconsumed, _, _, _ = self.batch(1, self.fixed, prefix="unconsumed")
        changed = self.store.read_json(commits[1])
        changed["consumedBatchDigest"] = unconsumed["digest"]
        with self.assertRaisesRegex(ContractError, "cursor and consumed batch"):
            self.builder.round_evidence(
                (commits[0], self.store.put_json(changed)), curriculum_ref=self.pool
            )

    def test_checkpoint_state_and_pre_update_model_must_match_the_committed_batch(self):
        commits, _, _ = self.job()
        changed = self.store.read_json(commits[1])
        checkpoint = self.store.read_json(changed["checkpointRef"])
        checkpoint["optimizerStateRef"] = self.fixed
        changed["checkpointRef"] = self.store.put_json(checkpoint)
        with self.assertRaisesRegex(ContractError, "optimizer"):
            self.builder.round_evidence(
                (commits[0], self.store.put_json(changed)), curriculum_ref=self.pool
            )
        wrong_batch, _, _, _ = self.batch(1, self.fixed)
        wrong_commit, _ = self.commit(wrong_batch, 2, commits[0])
        with self.assertRaisesRegex(ContractError, "pre-update model"):
            self.builder.round_evidence((commits[0], wrong_commit), curriculum_ref=self.pool)

    def test_optimizer_answer_classes_are_anchored_to_the_exact_curriculum(self):
        _, raws, lease, labels = self.batch(0, self.fixed)
        for key, value in (("curriculumRef", self.fixed), ("classifier", {"kind": "different"})):
            changed = self.store.read_json(labels)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(ContractError):
                self.builder.build(
                    (raws,),
                    lease=lease,
                    curriculum_ref=self.pool,
                    answer_classes_ref=self.store.put_json(changed),
                )
        with self.assertRaises(ContractError):
            self.builder.build(
                (self.construction["keep"][:2],),
                lease=lease,
                curriculum_ref=self.pool,
                answer_classes_ref=labels,
            )

    def test_resumed_job_preserves_parent_optimizer_lineage_and_update_offset(self):
        previous, _, _ = self.job()
        parent_ref = self.store.read_json(previous[-1])["checkpointRef"]
        parent = self.store.read_json(parent_ref)
        self.request["resumeCheckpointRef"] = parent_ref
        self.request["parentModel"]["hfSnapshotRef"] = parent["hfExportRef"]
        self.builder = DiagEvoSolverDatasetBuilder(self.store, self.request, policy=self.policy)
        first, _, _, _ = self.batch(2, parent["hfExportRef"], prefix="resumed")
        c1, exported = self.commit(first, 3)
        second, _, _, _ = self.batch(3, exported, answers="ab", prefix="resumed")
        c2, _ = self.commit(second, 4, c1)
        evidence = self.builder.round_evidence((c1, c2), curriculum_ref=self.pool)
        self.assertEqual(len(evidence.groups), 2)
        for key, value in (("optimizerStateRef", self.fixed), ("hfExportRef", self.fixed)):
            altered = self.store.put_json({**parent, key: value})
            request = {**self.request, "resumeCheckpointRef": altered}
            builder = DiagEvoSolverDatasetBuilder(self.store, request, policy=self.policy)
            with self.subTest(key=key), self.assertRaisesRegex(ContractError, "parent state"):
                builder.round_evidence((c1, c2), curriculum_ref=self.pool)

    def test_curriculum_tampering_and_missing_generation_coverage_fail_before_optimization(self):
        changed = self.store.read_json(self.pool)
        changed["votes"][0]["retained"] = True
        with self.assertRaisesRegex(ContractError, "curriculum evidence changed"):
            self.builder._pool(self.store.put_json(changed))
        with self.assertRaisesRegex(ContractError, "entire question pool"):
            self.seal_pool(generation={"keep": self.generation["keep"]})


if __name__ == "__main__":
    unittest.main()
