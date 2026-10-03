"""New recipes are CPU contract tests; upstream numerical tests never certify GPUs."""
import ast
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gear_training.content import ContentStore, ContractError, atomic_json, digest_json
from gear_training.driver import build_argv
from gear_training.offline import seal_dataset, read_dataset, seal_batch, validate_batch, validate_cursor, window
from gear_training.preflight import compatibility_digest, missing_probe_checks
from gear_training.recipes.registry import ESTIMATORS, validate_recipe_args, zero_variance_policy
from gear_training.recipes.source_contract import verify_source_contract
from gear_training.certification import scope, required_checks, inspect_certificate
from gear_training.ledger import Ledger
from gear_training.recovery import update_recovery
from test_placement import request_fixture, HYPERPARAMETERS, PATHS


def offline_fixture(store):
    request = request_fixture()
    request.update(trainingRunId="offline-run", recipeDigest=digest_json("recipe"), datasetSplitDigest=digest_json("split"),
                   fixedHarness={"commit": "1" * 40}, budgets={"totalGpuSeconds": 600})
    request["trainer"].update(recipe="offline-sft-v1", globalBatchSize=1, updatesPerCandidate=2)
    task = store.put_json({"task": "train"})
    request["trainDataset"] = {"tasks": [{"id": "train", "family": "train-family", "taskRef": task}], "exactDataAuthorized": True}
    model = store.put_json(request["parentModel"])
    source = {"taskId": "train", "family": "train-family", "taskDigest": task["digest"]}
    payload = {"schemaVersion": 1, "modelRef": model, "maxSequenceTokens": 64, "records": [
        {"source": source, "segments": [{"role": "user", "tokens": [1, 2]}, {"role": "assistant", "tokens": [3 + i, 4]},
                                      {"role": "tool", "tokens": [90, 91]}, {"role": "assistant", "tokens": [5]}]} for i in range(3)]}
    sealed = seal_dataset(store, payload)
    request["offlineTraining"] = {"datasetRef": sealed["datasetRef"], "shuffleSeed": 23, "maxEpochs": 2,
                                  "maxSequenceTokens": 64, "maskContract": "assistant-token-mask-v1"}
    return request, payload


class RecipesTests(unittest.TestCase):
    def test_native_estimator_dispatch_and_supervised_actor_only_argv(self):
        for recipe, estimator in ESTIMATORS.items():
            request = request_fixture(); request["trainer"]["recipe"] = recipe
            hp = copy.deepcopy(HYPERPARAMETERS)
            if recipe == "offline-sft-v1": hp["slimeArgs"] = ["--lr", "0.000001", "--num-steps-per-rollout", "1"]
            argv = build_argv(request, hp, PATHS, 4)
            self.assertEqual(argv[argv.index("--advantage-estimator") + 1], estimator)
            self.assertEqual(argv[argv.index("--num-rollout") + 1], "6")
            if recipe == "offline-sft-v1":
                self.assertEqual(argv[argv.index("--loss-type") + 1], "sft_loss")
                self.assertEqual(argv[argv.index("--rollout-num-gpus") + 1], "0")
                self.assertEqual(argv[argv.index("--n-samples-per-prompt") + 1], "1")
                self.assertIn("--debug-train-only", argv); self.assertNotIn("--use-rollout-logprobs", argv)
                self.assertNotIn("--colocate", argv); self.assertIn("--no-offload-rollout", argv)
            else:
                self.assertIn("--use-rollout-logprobs", argv)
                if estimator.startswith("reinforce_plus_plus"): self.assertIn("--normalize-advantages", argv)
                if estimator == "reinforce_plus_plus": self.assertIn("--disable-rewards-normalization", argv)
                if estimator == "reinforce_plus_plus_baseline": self.assertIn("--disable-grpo-std-normalization", argv)

    def test_sft_actual_megatron_sequence_limit_is_checked_before_actor_creation(self):
        request = request_fixture(); request["trainer"]["recipe"] = "offline-sft-v1"
        request["offlineTraining"] = {"maxSequenceTokens": 64}
        args = SimpleNamespace(loss_type="sft_loss", seq_length=32, debug_train_only=True, compute_advantages_and_returns=False,
                               use_rollout_logprobs=False, kl_coef=0, use_kl_loss=False, kl_loss_coef=0)
        with self.assertRaisesRegex(ContractError, "Megatron sequence length"): validate_recipe_args(args, request)
        args.seq_length = 64; validate_recipe_args(args, request)

    def test_reject_unknown_recipe_and_unsealed_loss_lifecycle_extensions(self):
        request = request_fixture()
        for recipe in ("ppo", "agent-opd-v1", "sft", "agent-gspo-v2"):
            request["trainer"]["recipe"] = recipe
            with self.assertRaises(ContractError): build_argv(request, HYPERPARAMETERS, PATHS, 0)
        request["trainer"]["recipe"] = "agent-gspo-v1"
        for flag in ("--loss-type=sft_loss", "--use-opd", "--data-source-path=private", "--async-train", "--custom-advantage-function-path=x"):
            hp = copy.deepcopy(HYPERPARAMETERS); hp["slimeArgs"].append(flag)
            with self.assertRaises(ContractError): build_argv(request, hp, PATHS, 0)

    def test_legacy_digest_unchanged_and_new_recipe_batch_identity_bound(self):
        request = request_fixture()
        old = compatibility_digest(request)
        request["trainer"]["recipe"] = "agent-grpo-v1"
        self.assertEqual(old, compatibility_digest(request))
        request["trainer"]["recipe"] = "agent-gspo-v1"
        original = compatibility_digest(request)
        self.assertNotEqual(old, original)
        request["trainer"]["rolloutBatchSize"] += 1
        self.assertNotEqual(original, compatibility_digest(request))

    def test_plain_reinforce_preserves_singleton_rewards(self):
        request = request_fixture(); request["trainer"]["recipe"] = "agent-reinforce-plus-plus-v1"
        request["rollout"].update(groupSize=1, zeroVarianceGroup="skip-with-bounded-resampling")
        self.assertEqual(zero_variance_policy(request), "keep")
        from gear_training.samples import EpisodeSample, admit_group, seal_batch as seal_online_batch
        with tempfile.TemporaryDirectory() as directory:
            store = ContentStore(directory); ref = store.put_json({"fixture": 1})
            request.update(trainingRunId="singleton", recipeDigest=ref["digest"], datasetSplitDigest=ref["digest"])
            metadata = {"slot": 0, "groupId": "one", "policyVersion": "policy", "taskDigest": "task", "environmentDigest": "env",
                        "harnessDigest": "harness", "samplingDigest": "sampling", "episodeId": "episode", "runId": "run"}
            sample = EpisodeSample(tokens=[1, 2], response_length=1, loss_mask=[1], rollout_log_probs=[-.2], reward=1, metadata=metadata)
            group = admit_group([sample], 1, zero_variance_policy(request))
            batch = store.read_json(seal_online_batch(store, [group], request, {"state": "closed", "policyVersion": "policy"}, []))
            self.assertEqual(store.read_json(batch["samplesRef"])[0][0]["reward"], 1)

    def test_new_certificate_is_recipe_harness_topology_scoped(self):
        request = request_fixture(); request["trainer"]["recipe"] = "agent-gspo-v1"; request["fixedHarness"] = {"commit": "1" * 40}
        first = scope(request); request["fixedHarness"]["commit"] = "2" * 40
        self.assertNotEqual(first, scope(request))
        self.assertIn("algorithmLossAndAdvantages", required_checks(request))
        request["trainer"]["placement"] = "separate"
        self.assertNotIn("colocatedMemoryCycle", required_checks(request))
        request["trainer"]["recipe"] = "offline-sft-v1"
        self.assertNotIn("behaviorLogProbs", required_checks(request)); self.assertIn("sftMaskedLoss", required_checks(request))
        with tempfile.TemporaryDirectory() as directory:
            self.assertIn("sftMaskedLoss", missing_probe_checks(request, ContentStore(directory)))


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.store = ContentStore(self.root / "cas")
        self.request, self.payload = offline_fixture(self.store)

    def test_authoring_masks_tool_system_user_and_first_token(self):
        data = read_dataset(self.store, self.request)
        row = self.store.read_json(data["records"][0])
        self.assertEqual(row["lossMask"], [0, 0, 1, 1, 0, 0, 1])
        for mutated in (True, -1, 2147483648):
            payload = copy.deepcopy(self.payload); payload["records"][0]["segments"][0]["tokens"][0] = mutated
            with self.assertRaises(ContractError): seal_dataset(self.store, payload)
        payload = copy.deepcopy(self.payload); payload["records"][0]["segments"] = [{"role": "user", "tokens": [1, 2]}]
        with self.assertRaises(ContractError): seal_dataset(self.store, payload)

    def test_chat_authoring_uses_native_template_mask_and_rejects_missing_spans(self):
        import torch
        from tokenizers import Tokenizer
        from tokenizers.models import WordLevel
        from tokenizers.pre_tokenizers import Whitespace
        from transformers import PreTrainedTokenizerFast
        from safetensors.torch import save_file
        from gear_training.artifacts import seal_hf
        vocab = {"[UNK]": 0, "user": 1, "question": 2, "assistant": 3, "answer": 4, "tool": 5, "observation": 6}
        backend = Tokenizer(WordLevel(vocab, unk_token="[UNK]")); backend.pre_tokenizer = Whitespace()
        tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, unk_token="[UNK]")
        tokenizer.chat_template = "{% for message in messages %}{{ message['role'] }} {% if message['role'] == 'assistant' %}{% generation %}{{ message['content'] }}{% endgeneration %}{% else %}{{ message['content'] }}{% endif %} {% endfor %}"
        hfdir = self.root / "tiny-hf"; hfdir.mkdir(); tokenizer.save_pretrained(hfdir)
        atomic_json(hfdir / "config.json", {"model_type": "gpt2", "architectures": ["GPT2LMHeadModel"], "torch_dtype": "float32", "vocab_size": len(vocab), "bos_token_id": None, "eos_token_id": None})
        save_file({"weight": torch.ones(1)}, hfdir / "model.safetensors")
        model = seal_hf(self.store, hfdir)
        source = self.payload["records"][0]["source"]
        payload = {"schemaVersion": 1, "modelRef": model["modelRef"], "maxSequenceTokens": 64, "records": [{"source": source,
            "messages": [{"role": "user", "content": "question"}, {"role": "assistant", "content": "answer"},
                         {"role": "tool", "content": "observation"}, {"role": "assistant", "content": "answer"}]}]}
        segments = {**payload, "records": [{"source": source, "segments": [{"role": "user", "tokens": [1]}, {"role": "assistant", "tokens": [len(vocab)]}]}]}
        with self.assertRaisesRegex(ContractError, "vocabulary"): seal_dataset(self.store, segments)
        config = json.loads((hfdir / "config.json").read_text()); config["max_position_embeddings"] = 32
        atomic_json(hfdir / "config.json", config); small = seal_hf(self.store, hfdir)
        overflow = {**payload, "modelRef": small["modelRef"]}
        with self.assertRaisesRegex(ContractError, "context capacity"): seal_dataset(self.store, overflow)
        dataset = self.store.read_json(seal_dataset(self.store, payload)["datasetRef"])
        row = self.store.read_json(dataset["records"][0])
        self.assertEqual([t for t, m in zip(row["tokens"], row["lossMask"]) if m], [vocab["answer"], vocab["answer"]])
        tokenizer.chat_template = "{% for message in messages %}{{ message['role'] }} {{ message['content'] }} {% endfor %}"
        tokenizer.save_pretrained(hfdir); model = seal_hf(self.store, hfdir); payload["modelRef"] = model["modelRef"]
        with self.assertRaisesRegex(ContractError, "generation spans"): seal_dataset(self.store, payload)

    def test_provenance_and_mask_leakage_rejected(self):
        self.request["trainDataset"]["tasks"][0]["family"] = "held-out"
        with self.assertRaisesRegex(ContractError, "authorized train"): read_dataset(self.store, self.request)
        self.request, _ = offline_fixture(self.store)
        dataset = self.store.read_json(self.request["offlineTraining"]["datasetRef"])
        row = self.store.read_json(dataset["records"][0]); row["lossMask"][4] = 1
        row["id"] = digest_json({k: v for k, v in row.items() if k != "id"})
        dataset["records"][0] = self.store.put_json(row)
        self.request["offlineTraining"]["datasetRef"] = self.store.put_json(dataset)
        with self.assertRaisesRegex(ContractError, "assistant tokens"): read_dataset(self.store, self.request)

    def test_deterministic_epoch_cursor_and_exhaustion(self):
        first = seal_batch(self.store, self.request, 0)
        self.assertEqual(first, seal_batch(self.store, self.request, 0))
        data = read_dataset(self.store, self.request)
        order = window(data["records"], 23, 0, 6)
        self.assertEqual(set(r["digest"] for r in order[:3]), set(r["digest"] for r in order[3:]))
        for update in range(6):
            batch = self.store.read_json(seal_batch(self.store, self.request, update))
            self.assertEqual(batch["recordRefs"], [order[update]])
            self.assertEqual(batch["cursorAfter"], {"position": update + 1})
        with self.assertRaisesRegex(ContractError, "epoch limit"): seal_batch(self.store, self.request, 6)
        other = copy.deepcopy(self.request); other["offlineTraining"]["shuffleSeed"] = 24
        with self.assertRaises(ContractError): validate_batch(self.store, other, first, 0)

    def test_pending_export_recovery_needs_no_online_lease_and_rejects_cursor_drift(self):
        batch = seal_batch(self.store, self.request, 0); trainer = self.store.put_json({"trainer": "complete"})
        cursor = {"committedUpdate": 1, "batchRef": batch, "position": 1, "datasetDigest": self.request["offlineTraining"]["datasetRef"]["digest"]}
        pending = {"committedUpdate": 1, "trainerStateRef": trainer, "batchRef": batch, "dataCursor": cursor,
                   "compatibilityDigest": compatibility_digest(self.request)}
        atomic_json(self.root / "pending-update.json", pending)
        ledger = Ledger(self.root / "ledger.sqlite"); self.addCleanup(ledger.close)
        self.assertEqual(update_recovery(self.root, self.request, self.store, ledger)["pending"], pending)
        pending["dataCursor"]["position"] = 2; atomic_json(self.root / "pending-update.json", pending)
        with self.assertRaisesRegex(ContractError, "cursor"): update_recovery(self.root, self.request, self.store, ledger)

    def test_committed_cursor_recovery_removes_lost_commit_reply_receipt(self):
        batch = seal_batch(self.store, self.request, 0); state = self.store.put_json({"trainer": "complete"})
        cursor = {"committedUpdate": 1, "batchRef": batch, "position": 1, "datasetDigest": self.request["offlineTraining"]["datasetRef"]["digest"]}
        cp = {"schemaVersion": 1, "committedUpdate": 1, "compatibilityDigest": compatibility_digest(self.request), "actorStateRef": state,
              "optimizerStateRef": state, "schedulerAndRngRef": state, "dataCursorRef": self.store.put_json(cursor)}
        cpref = self.store.put_json(cp)
        commit = self.store.put_json({"trainingRunId": self.request["trainingRunId"], "committedUpdate": 1, "checkpointRef": cpref,
             "consumedBatchDigest": batch["digest"], "rngRef": state, "dataCursorRef": cp["dataCursorRef"]})
        ledger = Ledger(self.root / "ledger.sqlite"); self.addCleanup(ledger.close); ledger.commit_update(1, batch["digest"], commit)
        atomic_json(self.root / "pending-update.json", {"committedUpdate": 1, "trainerStateRef": state, "batchRef": batch,
                    "dataCursor": cursor, "compatibilityDigest": compatibility_digest(self.request)})
        recovered = update_recovery(self.root, self.request, self.store, ledger)
        self.assertEqual(recovered["start"], 1); self.assertIsNone(recovered["pending"])
        cursor["position"] = 0; cp["dataCursorRef"] = self.store.put_json(cursor)
        with self.assertRaisesRegex(ContractError, "cursor"): validate_cursor(self.store, self.request, cp)


class OfflineDriverTests(unittest.TestCase):
    def helper(self):
        from test_driver_memory import DriverMemoryTests
        from test_placement import Remote
        helper = DriverMemoryTests(methodName="runTest"); helper.setUp(); self.addCleanup(helper.doCleanups)
        parent, reference = helper.request["parentModel"], helper.request["referenceModelRef"]
        helper.request, _ = offline_fixture(helper.store)
        helper.request.update(parentModel=parent, referenceModelRef=reference)
        helper.request["trainer"]["hyperparametersRef"] = helper.store.put_json({"schemaVersion": 1,
            "slimeArgs": ["--lr", "0.000001", "--num-steps-per-rollout", "1"]})
        helper.args.colocate = helper.args.offload_train = helper.args.offload_rollout = False
        helper.args.loss_type = "sft_loss"; helper.args.debug_train_only = True
        helper.args.compute_advantages_and_returns = helper.args.use_rollout_logprobs = helper.args.use_kl_loss = False
        helper.args.kl_coef = helper.args.kl_loss_coef = 0
        helper.args.n_samples_per_prompt = helper.args.global_batch_size = 1
        helper.args.check_weight_update_equal = False
        def generate(update):
            helper.rt.event("offline-generate")
            ref = seal_batch(helper.store, helper.request, update)
            atomic_json(helper.root / "batch.json", {"rolloutId": update, "batchRef": ref})
            return "sealed-supervised-data"
        helper.rt.manager.generate = Remote(generate)
        def forbidden(*a, **kw): raise AssertionError("offline driver attempted online engine access")
        helper.rt.manager.get_updatable_engines_and_lock = Remote(forbidden)
        helper.rt.actor.update_weights = forbidden
        return helper

    def assert_offline(self, helper):
        for event in ("update_weights", "onload_weights", "onload_kv", "offload_rollout", "check_weights"):
            self.assertNotIn(event, helper.rt.events)
        self.assertFalse((helper.root / "runtime.json").exists())
        self.assertFalse((helper.root / "slots").exists())
        ledger = Ledger(helper.root / "ledger.sqlite")
        try:
            self.assertEqual(ledger.db.execute("SELECT COUNT(*) FROM leases").fetchone()[0], 0)
            self.assertEqual(ledger.usage()["rolloutTokens"], 0)
        finally: ledger.close()

    def test_real_driver_offline_two_updates_and_lost_commit_reply_restart(self):
        helper = self.helper(); helper.fail_commit_reply = True
        with self.assertRaisesRegex(OSError, "response lost"): helper.run_driver()
        self.assertEqual(helper.rt.events.count("train"), 1)
        helper.fail_commit_reply = False; helper.run_driver()
        self.assertEqual(helper.rt.events.count("train"), 2)
        self.assertEqual(helper.rt.events.count("offline-generate"), 2)
        self.assertEqual(json.loads((helper.root / "outcome.json").read_text())["committedUpdate"], 2)
        self.assert_offline(helper)
        before = helper.rt.events[:]; helper.run_driver()
        self.assertEqual(helper.rt.events, before)  # completed job republishes without Ray/GPU/train

    def test_real_driver_pending_export_retry_never_retrains_saved_update(self):
        helper = self.helper(); original = helper.commit
        helper.commit = lambda *a, **kw: (_ for _ in ()).throw(OSError("export publication interrupted"))
        with self.assertRaisesRegex(OSError, "interrupted"): helper.run_driver()
        self.assertEqual(helper.rt.events.count("train"), 1)
        helper.commit = original; helper.run_driver()
        self.assertEqual(helper.rt.events.count("train"), 2)
        self.assertEqual(helper.rt.events.count("offline-generate"), 2)
        self.assertIn("exporter-released", helper.created_components)
        self.assert_offline(helper)

    def test_pause_between_offline_batches_preserves_cursor_and_resumes(self):
        helper = self.helper(); original = helper.commit
        def pause(*a, **kw):
            result = original(*a, **kw)
            atomic_json(helper.root / "cancel.json", {"reason": "pause"})
            return result
        helper.commit = pause; helper.run_driver()
        self.assertEqual(json.loads((helper.root / "outcome.json").read_text())["outcome"], "paused")
        self.assertEqual(helper.rt.events.count("train"), 1)
        (helper.root / "cancel.json").unlink(); helper.commit = original; helper.run_driver()
        self.assertEqual(helper.rt.events.count("train"), 2); self.assert_offline(helper)


@unittest.skipUnless(os.environ.get("GEAR_PINNED_SLIME_SOURCE"), "set GEAR_PINNED_SLIME_SOURCE to the exact locked checkout")
class PinnedSourceTests(unittest.TestCase):
    def test_real_locked_source_exposes_all_native_recipe_apis(self):
        root = os.environ["GEAR_PINNED_SLIME_SOURCE"]
        import subprocess
        self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), "41014d1f29e201137fdffce737bb8bac65bc5219")
        for recipe in ESTIMATORS:
            request = request_fixture(); request["trainer"]["recipe"] = recipe
            self.assertEqual(verify_source_contract(root, request)["sourceApi"], "verified")

    def test_actual_upstream_reward_preprocessing_keeps_singleton_and_centers_baseline(self):
        import torch
        tree = ast.parse((Path(os.environ["GEAR_PINNED_SLIME_SOURCE"]) / "slime/ray/rollout.py").read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RolloutManager")
        func = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_post_process_rewards")
        func.decorator_list = []
        namespace = {"torch": torch, "Sample": object}; exec(compile(ast.Module(body=[func], type_ignores=[]), "pinned-slime", "exec"), namespace)
        samples = [SimpleNamespace(get_reward_value=lambda args, r=r: r) for r in (1., 3.)]
        args = SimpleNamespace(advantage_estimator="reinforce_plus_plus", rewards_normalization=False, n_samples_per_prompt=1,
                               rollout_batch_size=2, grpo_std_normalization=True)
        manager = SimpleNamespace(args=args, custom_reward_post_process_func=None)
        self.assertEqual(namespace["_post_process_rewards"](manager, samples)[1], [1., 3.])
        args.advantage_estimator = "reinforce_plus_plus_baseline"; args.rewards_normalization = True; args.n_samples_per_prompt = 2; args.rollout_batch_size = 1
        self.assertEqual(namespace["_post_process_rewards"](manager, samples)[1], [-1., 1.])

@unittest.skipUnless(os.environ.get("GEAR_PINNED_SLIME_SOURCE"), "set GEAR_PINNED_SLIME_SOURCE to exact Slime checkout")
class PinnedSupervisedLossTests(unittest.TestCase):
    def test_offline_hook_samples_match_actual_pinned_train_data_conversion(self):
        import sys
        import torch
        from dataclasses import dataclass, field
        from enum import Enum
        from typing import Any
        from types import MethodType
        from gear_training.offline import generate_rollout
        pinned = Path(os.environ["GEAR_PINNED_SLIME_SOURCE"])
        type_tree = ast.parse((pinned / "slime/utils/types.py").read_text())
        sample_class = next(n for n in type_tree.body if isinstance(n, ast.ClassDef) and n.name == "Sample")
        namespace = {"__name__": __name__, "torch": torch, "dataclass": dataclass, "field": field, "Enum": Enum, "Any": Any}
        exec(compile(ast.Module(body=[sample_class], type_ignores=[]), "pinned-slime-sample", "exec"), namespace)
        Sample = namespace["Sample"]
        base_tree = ast.parse((pinned / "slime/rollout/base_types.py").read_text())
        output_class = next(n for n in base_tree.body if isinstance(n, ast.ClassDef) and n.name == "RolloutFnTrainOutput")
        exec(compile(ast.Module(body=[output_class], type_ignores=[]), "pinned-slime-output", "exec"), namespace)
        tree = ast.parse((pinned / "slime/ray/rollout.py").read_text())
        manager_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RolloutManager")
        namespace["get_source"] = lambda sample: "offline"
        for name in ("_convert_samples_to_train_data", "_post_process_rewards"):
            function = next(n for n in manager_class.body if isinstance(n, ast.FunctionDef) and n.name == name)
            exec(compile(ast.Module(body=[function], type_ignores=[]), "pinned-slime-conversion", "exec"), namespace)
        args = SimpleNamespace(advantage_estimator="grpo", rewards_normalization=False, rollout_top_p=1., reward_key=None)
        manager = SimpleNamespace(args=args, custom_reward_post_process_func=None, custom_convert_samples_to_train_data_func=None)
        manager._post_process_rewards = MethodType(namespace["_post_process_rewards"], manager)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = ContentStore(root / "cas"); request, _ = offline_fixture(store)
            atomic_json(root / "request.json", request); atomic_json(root / "config.json", {"storeRoot": str(store.root)})
            modules = {"slime.utils.types": SimpleNamespace(Sample=Sample),
                       "slime.rollout.base_types": SimpleNamespace(RolloutFnTrainOutput=namespace["RolloutFnTrainOutput"])}
            with patch.dict(sys.modules, modules), patch.dict(os.environ, {"GEAR_TRAINING_JOB": str(root)}):
                output = generate_rollout(args, 0, None)
            sample = output.samples[0][0]
            self.assertEqual(sample.status, Sample.Status.COMPLETED)
            self.assertEqual(sample.response_length, 5); self.assertEqual(sample.loss_mask, [1, 1, 0, 0, 1])
            data = namespace["_convert_samples_to_train_data"](manager, [sample])
            self.assertEqual(data["response_lengths"], [5]); self.assertEqual(data["loss_masks"], [[1, 1, 0, 0, 1]])
            self.assertEqual(data["rollout_mask_sums"], [3]); self.assertNotIn("rollout_log_probs", data)
            self.assertNotIn("teacher_log_probs", data); self.assertEqual(data["truncated"], [0])

    def test_actual_upstream_sft_loss_excludes_tool_tokens_and_backpropagates(self):
        import torch
        from typing import Callable
        tree = ast.parse((Path(os.environ["GEAR_PINNED_SLIME_SOURCE"]) / "slime/backends/megatron_utils/loss.py").read_text())
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "sft_loss_function")
        namespace = {"torch": torch, "Namespace": SimpleNamespace, "RolloutBatch": dict, "Callable": Callable}
        namespace["get_log_probs_and_entropy"] = lambda logits, **kw: (None, {"log_probs": [logits.reshape(-1)]})
        exec(compile(ast.Module(body=[func], type_ignores=[]), "pinned-slime-sft-loss", "exec"), namespace)
        logits = torch.tensor([-1., -100., -3.], requires_grad=True)
        mask = torch.tensor([1., 0., 1.])
        loss, _ = namespace["sft_loss_function"](SimpleNamespace(), {"response_lengths": [3], "total_lengths": [5], "unconcat_tokens": [[1, 2, 3, 90, 4]]},
            logits, lambda logprobs: (logprobs * mask).sum() / mask.sum())
        self.assertEqual(float(loss.detach()), 2.); loss.backward()
        self.assertEqual(logits.grad.tolist(), [-.5, 0., -.5])
