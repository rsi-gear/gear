"""Read a complete Slime checkpoint for HF export without an optimizer.

This worker cannot train or write trainer state. Its weight-only load is a
projection of an already sealed checkpoint, never a replacement for that state.
Heavy runtime imports stay inside the factory so CPU recovery needs no CUDA.
"""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path

from .content import require


def checkpoint_export_actor_class():
    from slime.ray.train_actor import TrainRayActor

    class CheckpointExportActor(TrainRayActor):
        def init(self, args, role, with_ref=False, with_opd_teacher=False):
            require(role == "actor" and not with_ref and not with_opd_teacher
                    and args.no_load_optim and args.no_load_rng and not args.finetune,
                    "invalid-export-worker", "checkpoint exporter only accepts a read-only actor load")
            require((Path(args.load) / "latest_checkpointed_iteration.txt").is_file(),
                    "missing-export-checkpoint", "export recovery requires complete native trainer state")
            super().init(args, role, with_ref=False, with_opd_teacher=False)
            from slime.backends.megatron_utils.initialize import init
            from slime.backends.megatron_utils.model_provider import get_model_provider_func
            from slime.backends.megatron_utils.checkpoint import load_checkpoint
            from megatron.training.training import get_model
            from megatron.core.enums import ModelType
            init(args)
            # DDP gradient buffers, Adam moments and FP32 master parameters are
            # unnecessary for reading saved weights and caused the recovery OOM.
            self.model = get_model(get_model_provider_func(args, "actor"),
                                   ModelType.encoder_or_decoder, wrap_with_ddp=False)
            self.model[0].role = "actor"
            iteration, _ = load_checkpoint(self.model, None, None,
                checkpointing_context={}, skip_load_to_model_and_opt=False)
            return iteration + 1

        def export_hf(self, path):
            from slime.backends.megatron_utils.hf_checkpoint_saver import save_hf_model_to_path
            save_hf_model_to_path(self.args, Path(path), self.model)

        def _forbidden(self, *args, **kwargs):
            require(False, "read-only-export-worker", "checkpoint exporter cannot train, save state or serve rollout")

        train = save_model = update_weights = set_rollout_manager = _forbidden
        sleep = wake_up = _get_parallel_config = _forbidden

    return CheckpointExportActor


@contextmanager
def checkpoint_exporter(args, pgs, committed_update):
    from slime.ray.placement_group import allocate_train_group
    export_args = deepcopy(args)
    export_args.no_load_optim = export_args.no_load_rng = True
    export_args.finetune = False
    # The worker lives for one export and never sleeps or generates. Avoid
    # initializing the offload allocator and its CPU backup for this projection.
    export_args.offload_train = False
    group = allocate_train_group(export_args, args.actor_num_nodes, args.actor_num_gpus_per_node,
        pgs["actor"], role="actor", with_ref=False, with_opd_teacher=False,
        actor_cls=checkpoint_export_actor_class())
    try:
        starts = group.create()
        require(isinstance(starts, list) and starts and all(type(x) is int and x == committed_update for x in starts),
                "export-checkpoint-update-drift", "loaded weights do not match the pending committed update")
        yield group
    finally:
        group.release()
