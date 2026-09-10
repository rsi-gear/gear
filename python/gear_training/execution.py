"""Interpret frozen v1/v2 placement without rewriting a request or its digest."""
from .content import require


def actor_rollout_placement(request):
    if request.get("schemaVersion", 1) == 1: return request["trainer"].get("placement", "separate")
    require(request["schemaVersion"] == 2 and "placement" not in request["trainer"], "invalid-v2-placement", "v2 placement is frozen in deployment")
    mode = request["deployment"]["gpuScheduling"]["actorRollout"]
    require(mode in ("colocated", "disaggregated"), "invalid-v2-placement", "unknown actor/rollout scheduling mode")
    return "colocated" if mode == "colocated" else "separate"


def training_devices(request):
    devices = request["trainingDevices"]
    if request.get("schemaVersion", 1) == 2:
        node = request["deployment"]["modelRuntime"]["nodeId"]
        require(all(isinstance(d, dict) and set(d) == {"nodeId", "gpuUuid"} and d["nodeId"] == node for d in devices),
                "training-node-drift", "GPU pool belongs to another model node")
        devices = [d["gpuUuid"] for d in devices]
    require(devices and all(isinstance(d, str) and d for d in devices) and len(devices) == len(set(devices)),
            "invalid-training-devices", "training requires unique physical GPU UUIDs")
    return devices
