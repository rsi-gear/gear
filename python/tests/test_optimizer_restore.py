"""CPU tensor checks for the second-load allocation and metadata boundary."""
from collections import defaultdict
import unittest

try:
    import torch
except ImportError:
    torch = None

from gear_training.optimizer_restore import load_distributed_optimizer_state


class FusedAdam(torch.optim.Optimizer if torch is not None else object):
    """Model TE's documented state-recreating loader, with CPU tensor storage."""
    def __init__(self, params):
        super().__init__(params, {"lr": 0.1, "step": 0})
        self.payload_counts = []
        self.fail = False

    def state_dict(self):
        result = super().state_dict()
        # Real TE returns fresh per-parameter dictionaries even when the FP32
        # tensors themselves are its existing storage destinations.
        result["state"] = {key: dict(value) for key, value in result["state"].items()}
        return result

    def load_state_dict(self, state_dict):
        self.payload_counts.append(len(state_dict["state"]))
        super().load_state_dict(state_dict)
        if self.fail:
            raise RuntimeError("loader failed")
        for state in self.state.values():
            for key, tensor in list(state.items()):
                if isinstance(tensor, torch.Tensor):
                    state[key] = tensor.float().clone()


FusedAdam.__module__ = "transformer_engine.pytorch.optimizers.fused_adam"


@unittest.skipIf(torch is None, "requires the CPU Torch validation environment")
class OptimizerRestoreTests(unittest.TestCase):
    def optimizer(self):
        params = [torch.nn.Parameter(torch.zeros(3, dtype=torch.bfloat16)) for _ in range(2)]
        optimizer = FusedAdam(params)
        for i, param in enumerate(params):
            optimizer.state[param] = {"exp_avg": torch.full((3,), i + 0.125, dtype=torch.float32),
                                      "exp_avg_sq": torch.full((3,), i + 2.125, dtype=torch.float32)}
        state = optimizer.state_dict()
        state["param_groups"][0].update(step=7, lr=1e-6)
        return optimizer, params, state

    def test_repeated_load_keeps_tensor_aliases_precision_and_restores_step_lr(self):
        optimizer, params, state = self.optimizer()
        original = optimizer.state
        tensors = [original[p]["exp_avg"] for p in params]
        load_distributed_optimizer_state(optimizer, state)
        self.assertEqual(optimizer.payload_counts, [0])
        self.assertIs(optimizer.state, original)
        self.assertEqual(optimizer.param_groups[0]["step"], 7)
        self.assertEqual(optimizer.param_groups[0]["lr"], 1e-6)
        for p, tensor in zip(params, tensors):
            self.assertIs(optimizer.state[p]["exp_avg"], tensor)
            self.assertEqual(tensor.dtype, torch.float32)
        # DCP may hold these original destinations. Its subsequent in-place
        # restore must still update the exact state consumed by the optimizer.
        state["state"][0]["exp_avg"].fill_(9)
        self.assertTrue(torch.equal(optimizer.state[params[0]]["exp_avg"], torch.full((3,), 9.)))

    def test_new_or_remapped_states_and_hooks_use_original_loader(self):
        for mode in ("new", "swapped", "copied-tensors", "hook", "other-optimizer"):
            with self.subTest(mode=mode):
                optimizer, params, state = self.optimizer()
                if mode == "new":
                    optimizer.state = defaultdict(dict)
                elif mode == "swapped":
                    state["state"][0], state["state"][1] = state["state"][1], state["state"][0]
                elif mode == "copied-tensors":
                    state["state"][0] = {key: tensor.clone() for key, tensor in state["state"][0].items()}
                elif mode == "hook":
                    optimizer.register_load_state_dict_pre_hook(lambda opt, value: value)
                else:
                    class Other(FusedAdam): pass
                    optimizer.__class__ = Other
                load_distributed_optimizer_state(optimizer, state)
                self.assertEqual(optimizer.payload_counts, [2])
                self.assertEqual(optimizer.param_groups[0]["step"], 7)

    def test_loader_failure_preserves_existing_destinations_and_propagates(self):
        optimizer, _, state = self.optimizer()
        original = optimizer.state
        optimizer.fail = True
        with self.assertRaisesRegex(RuntimeError, "loader failed"):
            load_distributed_optimizer_state(optimizer, state)
        self.assertIs(optimizer.state, original)


if __name__ == "__main__":
    unittest.main()
