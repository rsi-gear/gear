"""Resolve APIs moved between supported Slime runtime layouts."""
from importlib import import_module


def logging_api():
    try:
        module = import_module("slime.utils.logging_utils")
    except ModuleNotFoundError as error:
        if error.name != "slime.utils.logging_utils":
            raise
        module = import_module("slime.observability.logging_utils")
    return module.configure_logger, module.init_tracking, module.finish_tracking


def offload_logprob_backward(args, model, store_prefix):
    """Slime before-logprob hook: retain exact softmax tensors in host memory.

    Use with native log-prob chunking. This changes saved-tensor placement only;
    Slime still computes the same policy probabilities, entropy and gradients.
    """
    from functools import wraps
    from slime.backends.megatron_utils import actor, loss
    import torch

    original = loss.get_log_probs_and_entropy
    if actor.get_log_probs_and_entropy is not original:
        raise RuntimeError("Slime actor/loss logprob aliases differ")
    if getattr(original, "_gear_saved_logprob_cpu", False):
        return
    if getattr(args, "log_probs_chunk_size", -1) <= 0:
        raise ValueError("logprob backward offload requires native log-prob chunking")

    @wraps(original)
    def with_cpu_saved_tensors(*positional, **keywords):
        with torch.autograd.graph.save_on_cpu(pin_memory=True):
            return original(*positional, **keywords)

    with_cpu_saved_tensors._gear_saved_logprob_cpu = True
    loss.get_log_probs_and_entropy = with_cpu_saved_tensors
    actor.get_log_probs_and_entropy = with_cpu_saved_tensors
