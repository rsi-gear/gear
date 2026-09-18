"""Sealed GPU placement and the pinned Slime synchronous memory lifecycle."""
from __future__ import annotations

from .content import digest_json, require
from .execution import actor_rollout_placement, training_devices


RESOURCE_FLAGS = {"--actor-num-nodes", "--actor-num-gpus-per-node", "--rollout-num-gpus",
                  "--num-gpus-per-node", "--rollout-num-gpus-per-engine"}


def resource_plan(request, argv):
    """Resolve only resource flags; leave model/optimizer parsing to Slime.

    Colocated actor and rollout each cover the entire pool. Separate mode keeps
    explicit actor/rollout counts from the sealed recipe. No Slime 8-GPU default.
    """
    placement = actor_rollout_placement(request)
    require(placement in ("separate", "colocated"), "unsupported-resource-topology", "unknown trainer placement")
    devices = training_devices(request)
    require(devices and len(set(devices)) == len(devices), "invalid-training-devices", "training GPU pool must be nonempty and unique")
    values, remaining = {}, []
    i = 0
    while i < len(argv):
        key, sep, value = argv[i].partition("=")
        if key not in RESOURCE_FLAGS:
            remaining.append(argv[i]); i += 1; continue
        require(key not in values, "duplicate-resource-argument", "resource flag repeated: " + key)
        if not sep:
            i += 1
            require(i < len(argv), "invalid-resource-argument", "resource flag missing value: " + key)
            value = argv[i]
        require(value.isascii() and value.isdecimal() and int(value) > 0,
                "invalid-resource-argument", "resource count must be a positive integer: " + key)
        values[key] = int(value); i += 1
    count = len(devices)
    for key, expected in (("--actor-num-nodes", 1), ("--num-gpus-per-node", count)):
        require(values.get(key, expected) == expected, "resource-argument-conflict", "private single-node GPU pool conflicts with " + key)
        values[key] = expected
    if placement == "colocated":
        for key in ("--actor-num-gpus-per-node", "--rollout-num-gpus"):
            require(values.get(key, count) == count, "resource-argument-conflict", "colocated actor and rollout must each cover the full GPU pool")
            values[key] = count
    else:
        require("--actor-num-gpus-per-node" in values and "--rollout-num-gpus" in values,
                "unsealed-resource-allocation", "separate placement requires explicit actor and rollout GPU counts")
        require(values["--actor-num-gpus-per-node"] + values["--rollout-num-gpus"] <= count,
                "gpu-allocation-overflow", "separate actor plus rollout allocations exceed the GPU pool")
    values.setdefault("--rollout-num-gpus-per-engine", 1)
    dp = request["trainer"]["dataParallelSize"]
    require(type(dp) is int and dp > 0 and values["--actor-num-gpus-per-node"] % dp == 0,
            "data-parallel-drift", "actor GPU allocation must contain complete data parallel groups")
    require(values["--rollout-num-gpus"] % values["--rollout-num-gpus-per-engine"] == 0,
            "invalid-rollout-allocation", "rollout GPUs must contain complete single-node engines")
    return placement, values, remaining


def placement_probe_digest(request):
    """Bind offload evidence to the recipe/model shape and physical pool size.

    V1 retains its portable shape identity. V2 additionally binds the frozen
    node/provider deployment and physical pool; switching them needs new probes.
    Actor weights can change between updates without changing this layout.
    """
    t, model = request["trainer"], request["parentModel"]
    return digest_json({"schemaVersion": 1, "placement": actor_rollout_placement(request),
        "trainingDeviceCount": len(request["trainingDevices"]), "hyperparametersRef": t["hyperparametersRef"],
        "dataParallelSize": t["dataParallelSize"], "rolloutBatchSize": t["rolloutBatchSize"],
        "globalBatchSize": t["globalBatchSize"], "rollout": request["rollout"],
        **{key: model[key] for key in ("architecture", "dtype", "tokenizerDigest", "chatTemplateDigest")},
        **({"deployment": request["deployment"], "trainingDevices": request["trainingDevices"]} if request.get("schemaVersion") == 2 else {})})


def validate_resource_args(args, request, argv):
    placement, values, _ = resource_plan(request, argv)
    for key, expected in values.items():
        require(getattr(args, key[2:].replace("-", "_"), None) == expected,
                "resource-argument-drift", "Slime changed the sealed allocation: " + key)
    colocated = placement == "colocated"
    require(args.colocate == colocated and args.offload_train == colocated and args.offload_rollout == colocated
            and not args.use_critic and not args.release_train and not args.rollout_external,
            "unsupported-resource-topology", "placement requires synchronous actor/rollout ownership and matching offload flags")
    require(not getattr(args, "megatron_config_path", None) and not getattr(args, "sglang_config", None)
            and not getattr(args, "prefill_num_servers", None),
            "unsupported-resource-topology", "role overrides, multi-model and disaggregated serving are outside this placement contract")
    if colocated:
        require(args.update_weight_mode == "full" and args.update_weight_transport == "nccl",
                "unsupported-colocated-transfer", "colocated placement requires Slime's full tensor/IPC weight transfer")


class TrainingMemoryCycle:
    """Acknowledge each transition before starting work on the other resident.

    Construct after create_rollout_manager (offloads SGLang) and
    create_training_models (actor.init auto-sleeps). Train/save/export also
    auto-sleep in the pinned backend. Do not wake the full actor for weight sync:
    Slime's tensor updater reads the CPU weight backup in bounded GPU buckets.
    A failed transition is terminal for this driver incarnation.
    """
    def __init__(self, args, ray, actor, manager):
        self.args, self.ray, self.actor, self.manager = args, ray, actor, manager
        self.phase = "checkpoint"

    def _require(self, phase):
        require(self.phase == phase, "invalid-memory-transition", "memory phase is " + self.phase + ", expected " + phase)

    def prepare_rollout(self, *, compare_weights=False):
        self._require("checkpoint")
        self.phase = "transition"
        if self.args.offload_rollout:
            self.ray.get(self.manager.onload_weights.remote())
        self.actor.update_weights()
        if compare_weights:
            self.ray.get(self.manager.check_weights.remote(action="compare"))
        if self.args.offload_rollout:
            self.ray.get(self.manager.onload_kv.remote())
        self.phase = "rollout"

    def finish_rollout(self, barrier):
        self._require("rollout")
        # Must establish durable batch sealing AND quiescent Hitch/native calls.
        # In particular, never offload under an in-flight generation request.
        barrier()
        self.phase = "transition"
        if self.args.offload_rollout:
            self.ray.get(self.manager.offload.remote())
        self.phase = "checkpoint"

    def train_and_save(self, rollout_id, data):
        self._require("checkpoint")
        self.phase = "transition"
        self.ray.get(self.actor.async_train(rollout_id, data))
        self.actor.save_model(rollout_id, force_sync=True)
        self.phase = "checkpoint"

    def export_hf(self, path):
        self._require("checkpoint")
        self.phase = "transition"
        self.actor.export_hf(path)
        self.phase = "checkpoint"

    def complete_update(self):
        self._require("checkpoint")
        if not self.args.offload_train:
            self.actor.clear_memory()
