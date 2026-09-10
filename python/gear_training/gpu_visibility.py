"""Translate durable GPU UUIDs to the numeric CUDA IDs required by Slime."""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import uuid

from .content import require


def cuda_inventory():
    # Query the CUDA driver's enumeration, not NVML/nvidia-smi indices: those
    # indices need not match CUDA. cuInit/device queries create no GPU context.
    cuda = ctypes.CDLL("libcuda.so.1")
    def checked(name, *args):
        code = getattr(cuda, name)(*args)
        require(code == 0, "cuda-device-query-failed", f"{name} failed with CUDA status {code}")
    checked("cuInit", 0)
    count = ctypes.c_int()
    checked("cuDeviceGetCount", ctypes.byref(count))
    result = []
    uuid_function = "cuDeviceGetUuid_v2" if hasattr(cuda, "cuDeviceGetUuid_v2") else "cuDeviceGetUuid"
    for ordinal in range(count.value):
        device = ctypes.c_int()
        checked("cuDeviceGet", ctypes.byref(device), ordinal)
        value = (ctypes.c_ubyte * 16)()
        checked(uuid_function, ctypes.byref(value), device)
        result.append({"ordinal": ordinal, "uuid": "GPU-" + str(uuid.UUID(bytes=bytes(value)))})
    return result


def observe_cuda_devices(env):
    result = subprocess.run([sys.executable, "-m", "gear_training.gpu_visibility"],
                            env=env, capture_output=True, text=True, check=True, timeout=15)
    inventory = json.loads(result.stdout)
    require(isinstance(inventory, list) and all(isinstance(item, dict) and set(item) == {"ordinal", "uuid"}
            and type(item["ordinal"]) is int and item["ordinal"] >= 0
            and isinstance(item["uuid"], str) and item["uuid"].startswith("GPU-") for item in inventory)
            and len({item["uuid"] for item in inventory}) == len(inventory)
            and len({item["ordinal"] for item in inventory}) == len(inventory),
            "invalid-cuda-inventory", "CUDA device inventory is ambiguous")
    return inventory


def slime_device_environment(devices):
    env = {**os.environ, "CUDA_DEVICE_ORDER": "PCI_BUS_ID"}
    env.pop("CUDA_VISIBLE_DEVICES", None)
    inventory = observe_cuda_devices(env)
    ordinals = {item["uuid"]: item["ordinal"] for item in inventory}
    require(devices and len(set(devices)) == len(devices) and all(device in ordinals for device in devices),
            "unknown-training-cuda-device", "requested training GPUs are not present in CUDA's device inventory")
    return {"CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": ",".join(str(ordinals[device]) for device in devices)}


def verify_visible_devices(devices):
    inventory = observe_cuda_devices(dict(os.environ))
    actual = [item["uuid"] for item in sorted(inventory, key=lambda item: item["ordinal"])]
    require(actual == devices, "training-cuda-visibility-drift", "driver CUDA visibility differs from the requested GPU UUIDs")


if __name__ == "__main__":
    print(json.dumps(cuda_inventory()))
