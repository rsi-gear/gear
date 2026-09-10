"""CPU-only contract/failure tests. These never issue GPU probe evidence."""
from __future__ import annotations

import copy
import tempfile
import unittest
from types import SimpleNamespace

from gear_training.content import ContentStore, ContractError, digest_json
from gear_training.driver import build_argv
from gear_training.placement import TrainingMemoryCycle, resource_plan, validate_resource_args, placement_probe_digest
from gear_training.preflight import compatibility_digest, missing_probe_checks


def request_fixture():
    ref = {"uri": "cas:test", "digest": "sha256:" + "a" * 64, "mediaType": "application/json"}
    return {"trainer": {"placement": "colocated", "backend": "megatron", "runtimeLock": {"schemaVersion": 1, "validation": "pending-gpu", "probeEvidenceRefs": []},
        "hyperparametersRef": ref, "rolloutBatchSize": 1, "globalBatchSize": 2, "dataParallelSize": 1, "updatesPerCandidate": 2},
        "trainingDevices": ["GPU-0"], "parentModel": {"architecture": "TinyForCausalLM", "dtype": "bfloat16", "tokenizerDigest": ref["digest"], "chatTemplateDigest": ref["digest"]},
        "referenceModelRef": ref, "rollout": {"groupSize": 2, "sampling": {"temperature": 1, "topP": 1, "topK": -1, "repetitionPenalty": 1, "maxNewTokens": 16, "maxContextTokens": 128}}}


HYPERPARAMETERS = {"schemaVersion": 1, "slimeArgs": ["--lr", "0.000001", "--kl-coef", "0.01", "--eps-clip", "0.2", "--num-steps-per-rollout", "1"]}
PATHS = {k: "/test/" + k for k in ("load", "hf", "save", "reference")}


class Ref:
    def __init__(self, fn): self.fn = fn


class Remote:
    def __init__(self, fn): self.fn = fn
    def remote(self, *args, **kwargs): return Ref(lambda: self.fn(*args, **kwargs))


class FakeRay:
    """Side effects happen on acknowledgement, not on remote submission."""
    def get(self, refs):
        if isinstance(refs, list): return [self.get(ref) for ref in refs]
        return refs.fn()


class MemoryRuntime:
    def __init__(self, offload=True, fail=None):
        self.offload, self.fail, self.events = offload, fail, []
        # Pinned factories have already slept both sides when offload is enabled.
        self.actor_awake = self.weights = self.kv = not offload
        self.args = SimpleNamespace(offload_rollout=offload, offload_train=offload)
        self.ray = FakeRay()
        self.manager = SimpleNamespace(**{name: Remote(getattr(self, name)) for name in ("onload_weights", "onload_kv", "check_weights", "offload_rollout")})
        self.manager.offload = self.manager.offload_rollout
        self.actor = SimpleNamespace(update_weights=self.update_weights, async_train=lambda *a: Ref(self.train),
                                     save_model=lambda *a, **k: self.save(), export_hf=lambda *a: self.export(), clear_memory=self.clear)
        self.cycle = TrainingMemoryCycle(self.args, self.ray, self.actor, self.manager)

    def event(self, name):
        self.events.append(name)
        if name == self.fail: raise RuntimeError("injected " + name)

    def onload_weights(self):
        assert not self.actor_awake and not self.weights and not self.kv
        self.event("onload_weights"); self.weights = True

    def update_weights(self):
        if self.offload: assert not self.actor_awake and self.weights and not self.kv
        self.event("update_weights")

    def check_weights(self, **kwargs):
        assert self.weights
        self.event("check_weights")

    def onload_kv(self):
        assert not self.actor_awake and self.weights and not self.kv
        self.event("onload_kv"); self.kv = True

    def offload_rollout(self):
        assert not self.actor_awake and self.weights and self.kv
        self.event("offload_rollout"); self.weights = self.kv = False

    def actor_operation(self, name):
        if self.offload: assert not self.actor_awake and not self.weights and not self.kv
        self.actor_awake = True
        self.event(name)
        if self.offload: self.actor_awake = False

    def train(self): self.actor_operation("train")
    def save(self): self.actor_operation("save")
    def export(self): self.actor_operation("export")
    def clear(self): self.event("clear")


class PlacementTests(unittest.TestCase):
    def test_single_gpu_argv_replaces_upstream_eight_gpu_defaults(self):
        r = request_fixture()
        argv = build_argv(r, HYPERPARAMETERS, PATHS, 3)
        for flag in ("--actor-num-nodes", "--actor-num-gpus-per-node", "--rollout-num-gpus", "--num-gpus-per-node", "--rollout-num-gpus-per-engine"):
            self.assertEqual(argv[argv.index(flag) + 1], "1")
        for flag in ("--colocate", "--offload-train", "--offload-rollout"): self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--num-rollout") + 1], "5")
        self.assertEqual(argv[argv.index("--start-rollout-id") + 1], "3")

    def test_separate_legacy_recipe_keeps_disjoint_allocations(self):
        r = request_fixture(); del r["trainer"]["placement"]; r["trainingDevices"].append("GPU-1")
        hp = copy.deepcopy(HYPERPARAMETERS); hp["slimeArgs"] += ["--actor-num-gpus-per-node=1", "--rollout-num-gpus", "1"]
        argv = build_argv(r, hp, PATHS, 0)
        self.assertNotIn("--colocate", argv)
        self.assertIn("--no-offload-train", argv)
        self.assertEqual(argv[argv.index("--num-gpus-per-node") + 1], "2")
        r["trainingDevices"].pop()
        with self.assertRaisesRegex(ContractError, "exceed"): build_argv(r, hp, PATHS, 0)

    def test_conflicting_and_incomplete_resources_fail_before_ray(self):
        for extra in (["--actor-num-gpus-per-node", "2"], ["--num-gpus-per-node", "8"], ["--actor-num-nodes", "2"],
                      ["--rollout-num-gpus", "0"], ["--rollout-num-gpus-per-engine", "2"],
                      ["--rollout-num-gpus=1", "--rollout-num-gpus", "1"], ["--actor-num-nodes"],
                      ["--offload"], ["--no-offload-train"], ["--no-offload-rollout"], ["--sglang-config", "mutable.yaml"], ["--megatron-config-path", "mutable.yaml"]):
            with self.subTest(extra=extra):
                hp = copy.deepcopy(HYPERPARAMETERS); hp["slimeArgs"] += extra
                with self.assertRaises(ContractError): build_argv(request_fixture(), hp, PATHS, 0)

    def test_effective_slime_flags_must_match_sealed_placement(self):
        r = request_fixture(); argv = build_argv(r, HYPERPARAMETERS, PATHS, 0)
        _, values, _ = resource_plan(r, argv)
        args = SimpleNamespace(**{k[2:].replace("-", "_"): v for k, v in values.items()}, colocate=True,
            offload_train=True, offload_rollout=True, release_train=False, use_critic=False, rollout_external=False,
            update_weight_mode="full", update_weight_transport="nccl")
        validate_resource_args(args, r, argv)
        for name, value in (("colocate", False), ("offload_rollout", False), ("offload_train", False), ("release_train", True),
                            ("actor_num_gpus_per_node", 2), ("update_weight_transport", "disk"), ("megatron_config_path", "override.yaml")):
            changed = copy.copy(args); setattr(changed, name, value)
            with self.subTest(name=name), self.assertRaises(ContractError): validate_resource_args(changed, r, argv)

    def test_two_updates_acknowledge_memory_and_batch_barriers(self):
        rt = MemoryRuntime()
        for step in range(2):
            rt.cycle.prepare_rollout(compare_weights=step == 0)
            self.assertTrue(rt.weights and rt.kv and not rt.actor_awake)
            rt.event("generate")
            rt.cycle.finish_rollout(lambda: rt.event("sealed_and_quiescent"))
            rt.cycle.train_and_save(step, None)
            rt.cycle.export_hf("export")
            rt.cycle.complete_update()
        first = ["onload_weights", "update_weights", "check_weights", "onload_kv", "generate", "sealed_and_quiescent", "offload_rollout", "train", "save", "export"]
        self.assertEqual(rt.events, first + [name for name in first if name != "check_weights"])

    def test_unfinished_requests_prevent_offload_and_training(self):
        rt = MemoryRuntime(); rt.cycle.prepare_rollout()
        def blocked(): raise ContractError("missing-batch-barrier", "pending native request")
        with self.assertRaises(ContractError): rt.cycle.finish_rollout(blocked)
        for action in (lambda: rt.cycle.train_and_save(0, None), lambda: rt.cycle.export_hf("export")):
            with self.assertRaises(ContractError): action()
        self.assertEqual(rt.events, ["onload_weights", "update_weights", "onload_kv"])

    def test_failed_acknowledgement_never_starts_next_memory_phase(self):
        for fault in ("onload_weights", "update_weights", "onload_kv", "offload_rollout", "train", "save", "export"):
            with self.subTest(fault=fault):
                rt = MemoryRuntime(fail=fault)
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    rt.cycle.prepare_rollout()
                    rt.cycle.finish_rollout(lambda: None)
                    rt.cycle.train_and_save(0, None)
                    rt.cycle.export_hf("export")
                self.assertEqual(rt.events[-1], fault)
                with self.assertRaises(ContractError): rt.cycle.prepare_rollout()
                with self.assertRaises(ContractError): rt.cycle.train_and_save(1, None)

    def test_pending_checkpoint_export_needs_no_rollout_or_optimizer_step(self):
        rt = MemoryRuntime()
        rt.cycle.export_hf("pending-export")
        self.assertEqual(rt.events, ["export"])
        self.assertFalse(rt.actor_awake or rt.weights or rt.kv)
        rt.cycle.prepare_rollout()
        self.assertEqual(rt.events[1:], ["onload_weights", "update_weights", "onload_kv"])

    def test_separate_mode_preserves_clear_memory_without_offload(self):
        rt = MemoryRuntime(offload=False)
        rt.cycle.prepare_rollout()
        rt.cycle.finish_rollout(lambda: rt.event("barrier"))
        rt.cycle.train_and_save(0, None); rt.cycle.export_hf("export"); rt.cycle.complete_update()
        self.assertEqual(rt.events, ["update_weights", "barrier", "train", "save", "export", "clear"])

    def test_probes_cannot_certify_a_different_offload_recipe(self):
        with tempfile.TemporaryDirectory() as root:
            store = ContentStore(root); r = request_fixture(); lock = r["trainer"]["runtimeLock"]
            required = missing_probe_checks(r, store)
            probe = {"schemaVersion": 1, "kind": "gear-training-compatibility-probe", "runtimeLockIdentityDigest": digest_json({"schemaVersion": 1}), "checks": dict.fromkeys(required, True)}
            lock["probeEvidenceRefs"] = [store.put_json(probe)]
            self.assertEqual(missing_probe_checks(r, store), required)  # Old separate report cannot certify colocation.
            probe["placementIdentityDigest"] = placement_probe_digest(r)
            lock["probeEvidenceRefs"] = [store.put_json(probe)]
            self.assertEqual(missing_probe_checks(r, store), [])
            original = compatibility_digest(r)
            changed = copy.deepcopy(r); changed["trainer"]["placement"] = "separate"
            self.assertNotEqual(compatibility_digest(changed), original)
            changed = copy.deepcopy(r); changed["trainingDevices"].append("GPU-1")
            self.assertEqual(missing_probe_checks(changed, store), required)
            changed = copy.deepcopy(r); changed["rollout"]["sampling"]["maxNewTokens"] = 64
            self.assertEqual(missing_probe_checks(changed, store), required)
            changed = copy.deepcopy(r); changed["trainingDevices"] = ["GPU-another-host"]
            self.assertEqual(missing_probe_checks(changed, store), [])


if __name__ == "__main__": unittest.main()
