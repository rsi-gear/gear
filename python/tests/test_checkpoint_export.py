"""Check the read-only recovery boundary without constructing CUDA models."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from gear_training.checkpoint_export import checkpoint_export_actor_class, checkpoint_exporter
from gear_training.content import ContractError


class CheckpointExportTests(unittest.TestCase):
    def test_export_group_clones_args_checks_all_ranks_and_releases_on_failures(self):
        args = SimpleNamespace(actor_num_nodes=1, actor_num_gpus_per_node=2,
            no_load_optim=False, no_load_rng=False, finetune=False, offload_train=True)
        for starts, failure in (([3, 3], None), ([3, 2], "update"), ([True, True], "update"), ([3, 3], "writer")):
            group = SimpleNamespace(create=Mock(return_value=starts), release=Mock())
            allocate = Mock(return_value=group)
            with patch.dict(sys.modules, {"slime.ray.placement_group": SimpleNamespace(allocate_train_group=allocate)}), \
                    patch("gear_training.checkpoint_export.checkpoint_export_actor_class", return_value="export-class"):
                def exercise():
                    with checkpoint_exporter(args, {"actor": "pg"}, 3) as actual:
                        self.assertIs(actual, group)
                        if failure == "writer": raise OSError("writer")
                if failure == "update":
                    with self.assertRaisesRegex(ContractError, "pending committed update"): exercise()
                elif failure == "writer":
                    with self.assertRaises(OSError): exercise()
                else: exercise()
            group.release.assert_called_once()
            exported = allocate.call_args.args[0]
            self.assertIsNot(exported, args)
            self.assertTrue(exported.no_load_optim and exported.no_load_rng)
            self.assertFalse(exported.offload_train or exported.finetune)
            self.assertFalse(args.no_load_optim or args.no_load_rng)
            self.assertTrue(args.offload_train)
            self.assertFalse(allocate.call_args.kwargs["with_ref"])
            self.assertFalse(allocate.call_args.kwargs["with_opd_teacher"])

    def test_worker_loads_only_model_and_calls_pinned_hf_writer(self):
        class Base:
            def init(self, args, role, **kwargs): self.args = args
        model = [SimpleNamespace()]
        build = Mock(return_value=model); load = Mock(return_value=(6, 0)); writer = Mock()
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "latest_checkpointed_iteration.txt").write_text("6")
            args = SimpleNamespace(load=directory, no_load_optim=True, no_load_rng=True, finetune=False)
            modules = {
                "slime.ray.train_actor": SimpleNamespace(TrainRayActor=Base),
                "slime.backends.megatron_utils.initialize": SimpleNamespace(init=Mock()),
                "slime.backends.megatron_utils.model_provider": SimpleNamespace(get_model_provider_func=lambda a, role: "provider"),
                "slime.backends.megatron_utils.checkpoint": SimpleNamespace(load_checkpoint=load),
                "slime.backends.megatron_utils.hf_checkpoint_saver": SimpleNamespace(save_hf_model_to_path=writer),
                "megatron.training.training": SimpleNamespace(get_model=build),
                "megatron.core.enums": SimpleNamespace(ModelType=SimpleNamespace(encoder_or_decoder="decoder")),
            }
            with patch.dict(sys.modules, modules):
                actor = checkpoint_export_actor_class()()
                self.assertEqual(actor.init(args, "actor"), 7)
                build.assert_called_once_with("provider", "decoder", wrap_with_ddp=False)
                self.assertEqual(load.call_args.args, (model, None, None))
                self.assertFalse(load.call_args.kwargs["skip_load_to_model_and_opt"])
                actor.export_hf("output")
                writer.assert_called_once_with(args, Path("output"), model)
                for method in ("train", "save_model", "update_weights", "set_rollout_manager", "sleep", "wake_up"):
                    with self.assertRaisesRegex(ContractError, "cannot train"): getattr(actor, method)()
                with self.assertRaisesRegex(ContractError, "read-only actor"):
                    actor.init(args, "actor", with_ref=True)


if __name__ == "__main__": unittest.main()
