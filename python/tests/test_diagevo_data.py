"""Native batch/receipt contract fixtures, not a GPU or LLM experiment."""

import copy
import importlib.util
import tempfile
import unittest
from dataclasses import asdict, replace

from gear.training.data.samples import build_episode
from gear.training.data.trajectories import RawTrajectory
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.storage.content import ContentStore, ContractError, digest_json


@unittest.skipUnless(
    all(importlib.util.find_spec(name) is not None for name in ("nltk", "sklearn")),
    "install the training-metrics extra to test the native challenger batch",
)
class NativeRewardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = ContentStore(temporary.name)
        self.fixed = self.store.put_json({"kind": "cpu-fixture-fixed-input"})
        self.request = {
            "schemaVersion": 2,
            "trainingRunId": "train-challenger",
            "recipeDigest": self.fixed["digest"],
            "datasetSplitDigest": self.fixed["digest"],
            "trainer": {"recipe": "agent-grpo-v1", "rolloutBatchSize": 1},
            "rollout": {
                "groupSize": 2,
                "zeroVarianceGroup": "keep",
                "sampling": {
                    "temperature": 1,
                    "topP": 1,
                    "topK": -1,
                    "repetitionPenalty": 1,
                    "maxNewTokens": 512,
                    "maxContextTokens": 2048,
                },
            },
            "parentModel": {
                "tokenizerDigest": self.fixed["digest"],
                "chatTemplateDigest": self.fixed["digest"],
            },
            "fixedHarness": {"manifestRef": self.fixed},
            "verifier": self.fixed,
            "trainDataset": {
                "tasks": [
                    {
                        "id": "generate",
                        "taskRef": self.fixed,
                        "environmentRef": self.fixed,
                    }
                ]
            },
            "budgets": {"maxEpisodeSteps": 1},
        }
        self.sampling = sampling_params(self.request["rollout"])
        self.lease = {
            "state": "closed",
            "trainingRunId": "train-challenger",
            "batchId": "batch-0",
            "policyVersion": "challenger-v1",
            "runtimeInstanceId": "challenger-runtime",
            "samplingDigest": digest_json(self.sampling),
            "synchronizedWeightsRef": self.fixed,
        }
        self.objective = DiagEvoChallengerReward(group_size=2)
        self.builder = DiagEvoChallengerDatasetBuilder(
            self.store, self.request, objective=self.objective
        )

    def capture(self, name, prompt, response, *, solver=False, slot=0, policy=None, system="solve"):
        policy = policy or ("solver-v1" if solver else "challenger-v1")
        context = {
            "id": name,
            "runId": "run/" + name,
            "groupId": "group-0",
            "slot": slot,
            "taskId": "solve" if solver else "generate",
            "logicalAttempt": 1,
            "policyVersion": policy,
            "runtimeInstanceId": "solver-runtime" if solver else "challenger-runtime",
            "tokenizerDigest": self.fixed["digest"],
            "chatTemplateDigest": self.fixed["digest"],
            "harnessRef": self.fixed,
            "taskRef": self.fixed,
            "environmentRef": self.fixed,
            "sampling": self.sampling,
            "maxContextTokens": 2048,
            "maxEpisodeSteps": 1,
            "verifierVersion": self.fixed["digest"],
            "batchId": "batch-0",
            "trainingRunId": "train-solver" if solver else "train-challenger",
        }
        # Byte tokens make the fixture text/IDs inspectable without claiming an
        # actual model tokenizer, policy likelihood, native engine, or training.
        inputs = list(prompt.encode())
        outputs = [*response.encode(), 0]
        receipt = {
            "schemaVersion": 1,
            "id": "receipt/" + name,
            "episodeId": name,
            "callIndex": 0,
            "requestId": "request/" + name,
            **{
                key: context[key]
                for key in (
                    "runId",
                    "taskId",
                    "logicalAttempt",
                    "policyVersion",
                    "runtimeInstanceId",
                    "tokenizerDigest",
                    "chatTemplateDigest",
                )
            },
            "effectiveSamplingRef": self.store.put_json(self.sampling),
            "inputTokenIdsRef": self.store.put_json(inputs),
            "outputTokenIdsRef": self.store.put_json(outputs),
            "behaviorLogProbsRef": self.store.put_json([-0.1] * len(outputs)),
            "rawRequestRef": self.store.put_json(
                {
                    "agent": {
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ]
                    },
                    "native": {"input_ids": inputs},
                }
            ),
            "rawResponseRef": self.store.put_json(
                {
                    "native": {"output_ids": outputs},
                    "wire": {
                        "choices": [
                            {
                                "finish_reason": "stop",
                                "message": {"role": "assistant", "content": response},
                            }
                        ]
                    },
                }
            ),
            "finishReason": "stop",
            "complete": True,
        }
        feedback = {
            "schemaVersion": 1,
            "id": "feedback/" + name,
            "episodeId": name,
            "runId": context["runId"],
            "receiptIds": [receipt["id"]],
            "verifierVersion": self.fixed["digest"],
            "verifierEvidenceRef": self.fixed,
            "outcome": "valid",
            "reward": 7,
        }
        episode = {
            "schemaVersion": 1,
            **{
                key: context[key]
                for key in (
                    "id",
                    "groupId",
                    "slot",
                    "runId",
                    "policyVersion",
                    "harnessRef",
                    "taskRef",
                    "environmentRef",
                )
            },
            "receiptIds": feedback["receiptIds"],
            "feedbackId": feedback["id"],
            "termination": "terminated",
            "eligibility": "eligible",
            "rejectionReasons": [],
        }
        return RawTrajectory(
            self.store.put_json(episode),
            self.store.put_json(feedback),
            [self.store.put_json(receipt)],
            self.store.put_json(context),
        )

    def groups(self, responses=None):
        responses = responses or (
            "<question>alpha beta gamma delta</question>",
            "<question>one two three four</question>",
        )
        return (
            tuple(
                self.capture(f"q{index}", "generate a question", text, slot=index)
                for index, text in enumerate(responses)
            ),
        )

    def construction(self, groups, *, answers=None, system="solve"):
        labels, captures = [], {}
        for question_id, question in self.builder.questions(groups, lease=self.lease):
            keys = (answers or {}).get(question_id, "a" * 6 + "b" * 6)
            captures[question_id] = tuple(
                self.capture(
                    f"solver/{question_id}/{index}",
                    question,
                    "answer " + key,
                    solver=True,
                    slot=index,
                    system=system,
                )
                for index, key in enumerate(keys)
            )
            for raw, key in zip(captures[question_id], keys, strict=True):
                labels.append(
                    {
                        "trajectoryDigest": digest_json(asdict(raw)),
                        "answerKey": key,
                        "evidenceRef": self.store.put_json({"fixtureAnswerClass": key}),
                    }
                )
        classification = self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "diagevo-answer-classes",
                "classifier": {"kind": "cpu-fixture", "version": 1},
                "labels": labels,
            }
        )
        return captures, classification

    def build(self, groups, captures, classification):
        return self.builder.build(
            groups,
            lease=self.lease,
            solver_policy_id="solver-v1",
            solver_trajectories=captures,
            answer_classes_ref=classification,
        )

    def test_sealed_native_batch_preserves_original_tokens_and_feedback_with_new_rewards(self):
        groups = self.groups()
        captures, classification = self.construction(groups, answers={"q1": "a" * 9 + "b" * 3})
        snapshot = copy.deepcopy((groups, captures, classification))
        batch_ref = self.build(groups, captures, classification)
        self.assertEqual(self.build(groups, captures, classification), batch_ref)
        self.assertEqual(snapshot, (groups, captures, classification))
        batch = self.store.read_json(batch_ref)
        native = self.store.read_json(batch["samplesRef"])[0]
        self.assertEqual([row["reward"] for row in native], [0.5, 0])
        for raw, row in zip(groups[0], native, strict=True):
            original = build_episode(
                self.store,
                self.store.read_json(raw.episode_ref),
                [self.store.read_json(ref) for ref in raw.receipt_refs],
                self.store.read_json(raw.feedback_ref),
                self.store.read_json(raw.context_ref),
            )
            for key in ("tokens", "response_length", "loss_mask", "rollout_log_probs"):
                self.assertEqual(row[key], getattr(original, key))
            self.assertEqual(row["metadata"]["originalVerifierReward"], 7)
            self.assertEqual(self.store.read_json(raw.feedback_ref)["reward"], 7)
            self.assertEqual(row["metadata"]["policyVersion"], "challenger-v1")
            self.assertEqual(row["metadata"]["rewardSource"], "diagevo-challenger-v1")
        proof_ref = native[0]["metadata"]["curriculumRewardRef"]
        proof = self.store.read_json(proof_ref)
        self.assertIn(proof_ref, batch["sourceEvidenceRefs"])
        self.assertEqual(proof["answerClassesRef"], classification)
        self.assertFalse(proof["rewards"][0]["vote"]["retained"])
        self.assertEqual(proof["implementation"]["packages"].keys(), {"nltk", "scikit-learn"})

    def test_completed_format_errors_keep_full_zero_reward_groups(self):
        for responses, expected in (
            (("<question>alpha beta gamma delta</question>", "bad format"), [0.5, 0]),
            (("bad format", "also invalid"), [0, 0]),
        ):
            with self.subTest(responses=responses):
                groups = self.groups(responses)
                captures, classification = self.construction(groups)
                batch = self.store.read_json(self.build(groups, captures, classification))
                rows = self.store.read_json(batch["samplesRef"])[0]
                self.assertEqual([row["reward"] for row in rows], expected)
                self.assertEqual([row["metadata"]["slot"] for row in rows], [0, 1])

    def test_partial_batches_open_leases_and_unadmitted_tasks_fail_before_solver_calls(self):
        groups = self.groups()
        for values, lease in (
            ((), self.lease),
            ((groups[0][:1],), self.lease),
            (groups, {**self.lease, "state": "serving"}),
            (groups, {**self.lease, "policyVersion": "stale"}),
            (groups, {**self.lease, "batchId": "other"}),
            (groups, {**self.lease, "samplingDigest": "other"}),
        ):
            with self.subTest(lease=lease), self.assertRaises(ContractError):
                self.builder.questions(values, lease=lease)
        request = copy.deepcopy(self.request)
        request["trainDataset"]["tasks"][0]["id"] = "different-admitted-task"
        builder = DiagEvoChallengerDatasetBuilder(self.store, request, objective=self.objective)
        with self.assertRaisesRegex(ContractError, "authorized task"):
            builder.questions(groups, lease=self.lease)

    def test_recipe_cannot_skip_zero_groups_or_silently_enable_nucleus_sampling(self):
        for section, key, value in (
            ("rollout", "zeroVarianceGroup", "skip-with-bounded-resampling"),
            ("rollout", "groupSize", 4),
            ("trainer", "recipe", "offline-sft-v1"),
        ):
            request = copy.deepcopy(self.request)
            request[section][key] = value
            with self.subTest(value=value), self.assertRaises(ContractError):
                DiagEvoChallengerDatasetBuilder(self.store, request, objective=self.objective)
        request = copy.deepcopy(self.request)
        request["rollout"]["sampling"]["topP"] = 0.99
        with self.assertRaisesRegex(ContractError, "nucleus"):
            DiagEvoChallengerDatasetBuilder(self.store, request, objective=self.objective)

    def test_exact_native_receipts_still_reject_incomplete_or_misaligned_tokens(self):
        groups = self.groups()
        for field, value in (
            ("complete", False),
            ("finishReason", "length"),
            ("behaviorLogProbsRef", self.store.put_json([-0.1])),
            ("requestId", "request/q0"),
        ):
            raw = groups[0][1]
            receipt = {**self.store.read_json(raw.receipt_refs[0]), field: value}
            modified = replace(raw, receipt_refs=[self.store.put_json(receipt)])
            with self.subTest(field=field), self.assertRaises(ContractError):
                self.builder.questions(((groups[0][0], modified),), lease=self.lease)

    def test_solver_coverage_and_complete_construction_groups_are_required(self):
        groups = self.groups()
        captures, classification = self.construction(groups)
        for values in (
            {"q0": captures["q0"]},
            {**captures, "extra": ()},
            {**captures, "q1": captures["q1"][:-1]},
            {**captures, "q1": captures["q0"]},
        ):
            with self.subTest(keys=tuple(values)), self.assertRaises((ContractError, ValueError)):
                self.build(groups, values, classification)

    def test_challenger_group_binds_actual_prompt_even_when_task_metadata_matches(self):
        groups = self.groups()
        raw = groups[0][1]
        receipt = self.store.read_json(raw.receipt_refs[0])
        request = self.store.read_json(receipt["rawRequestRef"])
        request["agent"]["messages"][-1]["content"] = "generate a different kind of question"
        receipt["rawRequestRef"] = self.store.put_json(request)
        revised = replace(raw, receipt_refs=[self.store.put_json(receipt)])
        with self.assertRaisesRegex(ValueError, "one prompt"):
            self.builder.questions(((groups[0][0], revised),), lease=self.lease)

    def test_distinct_questions_still_require_the_same_frozen_solver(self):
        groups = self.groups()
        captures, classification = self.construction(groups)
        keys = "a" * 6 + "b" * 6
        captures["q1"] = tuple(
            self.capture(
                f"replacement/{index}",
                "one two three four",
                "answer " + key,
                solver=True,
                slot=index,
                policy="updated-solver",
            )
            for index, key in enumerate(keys)
        )
        proof = self.store.read_json(classification)
        proof["labels"][12:] = [
            {
                "trajectoryDigest": digest_json(asdict(raw)),
                "answerKey": key,
                "evidenceRef": self.fixed,
            }
            for raw, key in zip(captures["q1"], keys, strict=True)
        ]
        with self.assertRaisesRegex(ContractError, "one frozen solver"):
            self.build(groups, captures, self.store.put_json(proof))

    def test_coherent_solver_captures_cannot_replace_the_requested_frozen_policy(self):
        groups = self.groups()
        captures, classification = self.construction(groups)
        for requested_policy in (None, "different-frozen-solver"):
            with self.subTest(policy=requested_policy), self.assertRaises(ContractError):
                self.builder.build(
                    groups,
                    lease=self.lease,
                    solver_policy_id=requested_policy,
                    solver_trajectories=captures,
                    answer_classes_ref=classification,
                )

    def test_solver_questions_and_frozen_instruction_prefix_cannot_change(self):
        groups = self.groups()
        captures, classification = self.construction(groups)
        for body in (
            {"messages": [{"role": "user", "content": "different question"}]},
            {
                "messages": [
                    {"role": "system", "content": "changed instructions"},
                    {"role": "user", "content": "alpha beta gamma delta"},
                ]
            },
        ):
            altered = copy.deepcopy(captures)
            raw = captures["q0"][0]
            receipt = self.store.read_json(raw.receipt_refs[0])
            receipt["rawRequestRef"] = self.store.put_json({"agent": body})
            revised = replace(raw, receipt_refs=[self.store.put_json(receipt)])
            altered["q0"] = (revised,) + captures["q0"][1:]
            labels = self.store.read_json(classification)
            labels["labels"][0]["trajectoryDigest"] = digest_json(asdict(revised))
            with self.subTest(body=body), self.assertRaises(ContractError):
                self.build(groups, altered, self.store.put_json(labels))

    def test_classification_cannot_omit_duplicate_or_add_unobserved_answer_labels(self):
        groups = self.groups()
        captures, classification = self.construction(groups)
        original = self.store.read_json(classification)
        for labels in (
            original["labels"][:-1],
            original["labels"] + original["labels"][:1],
            original["labels"] + [{**original["labels"][0], "trajectoryDigest": "unknown"}],
        ):
            invalid = self.store.put_json({**original, "labels": labels})
            with self.subTest(count=len(labels)), self.assertRaises(ContractError):
                self.build(groups, captures, invalid)

    def test_caller_mutations_do_not_change_frozen_builder_parameters(self):
        self.request["rollout"]["groupSize"] = 8
        self.objective.repetition_weight = 50
        groups = self.groups()
        captures, classification = self.construction(groups)
        batch = self.store.read_json(self.build(groups, captures, classification))
        rows = self.store.read_json(batch["samplesRef"])[0]
        self.assertEqual([row["reward"] for row in rows], [0.5, 0.5])


if __name__ == "__main__":
    unittest.main()
