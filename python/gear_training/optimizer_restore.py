"""Preserve TE's already allocated distributed-checkpoint tensor destinations.

Megatron invokes the optimizer loader both while allocating DCP destinations and
after reading the checkpoint. TE recreates all tensor state on every invocation.
This adapter avoids that second allocation only for the exact identity mapping
produced by the pinned distributed optimizer. Checkpoint values, parameter-group
metadata and optimizer math remain owned by Megatron and Transformer Engine.
"""


def _reuses_existing_state(optimizer, state_dict):
    kind = type(optimizer)
    if (kind.__module__, kind.__name__) != (
            "transformer_engine.pytorch.optimizers.fused_adam", "FusedAdam"):
        return False
    if not optimizer.state or any(getattr(optimizer, name, None) for name in (
            "_optimizer_load_state_dict_pre_hooks", "_optimizer_load_state_dict_post_hooks")):
        return False
    groups, saved = optimizer.param_groups, state_dict["param_groups"]
    if len(groups) != len(saved):
        return False
    matched = set()
    for group, saved_group in zip(groups, saved):
        if len(group["params"]) != len(saved_group["params"]):
            return False
        for param, key in zip(group["params"], saved_group["params"]):
            if key in state_dict["state"]:
                incoming, resident = state_dict["state"][key], optimizer.state.get(param)
                # TE.state_dict creates a fresh dictionary for each parameter.
                # Only the actual tensor objects identify unchanged destinations.
                if (key in matched or not isinstance(incoming, dict) or not isinstance(resident, dict)
                        or incoming.keys() != resident.keys()
                        or any(value is not resident[name] for name, value in incoming.items())):
                    return False
                matched.add(key)
            elif param in optimizer.state:
                return False
    return len(matched) == len(state_dict["state"]) == len(optimizer.state)


def load_distributed_optimizer_state(optimizer, state_dict):
    if not _reuses_existing_state(optimizer, state_dict):
        return optimizer.load_state_dict(state_dict)
    existing = optimizer.state
    try:
        # Retain TE/Torch's parameter-group validation and step/lr restoration.
        # An empty state payload avoids dtype casts and a second CUDA allocation;
        # the original destination tensors stay alive for Megatron's subsequent
        # load_parameter_state call, including precision-aware state/scales.
        return optimizer.load_state_dict({**state_dict, "state": {}})
    finally:
        optimizer.state = existing
