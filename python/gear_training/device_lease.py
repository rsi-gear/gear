"""One model-node ledger for Slime and immutable evaluation processes.

Loss of a client connection never expires a device reservation. An owner must
fence future launches, prove its processes dead, and query the physical devices
before releasing. Time is charged once per unique physical device.
"""
from pathlib import Path
import time

from .content import atomic_json, digest_json, require
from .preflight import gpu_processes
from .recovery import owned_alive
from .state import load, lock
from .node_generation import previous_boot_proof


class NodeDeviceLedger:
    def __init__(self, root, node):
        self.root, self.node = Path(root), node
        self.path = self.root / "device-leases.json"

    def _read(self):
        current = load(self.root / "identity.json")
        require(current and all(current.get(k) == v for k, v in self.node.items()),
                "node-generation-drift", "device ledger belongs to another node generation")
        return load(self.path, {"schemaVersion": 2, "owners": {}})

    @staticmethod
    def _charge(entry):
        end = entry.get("releasedAt", time.time())
        entry["gpuSeconds"] = max(entry["gpuSeconds"], max(0, end - entry["acquiredAt"]) * len(entry["devices"]))

    def _entry(self, data, owner):
        entry = data["owners"].get(digest_json(owner))
        require(entry and entry["owner"] == owner and entry["node"] == self.node,
                "device-owner-mismatch", "device lease owner or generation does not match")
        return entry

    def acquire(self, owner, devices):
        require(isinstance(owner, str) and owner and isinstance(devices, list)
                and all(isinstance(d, str) and d for d in devices) and len(devices) == len(set(devices)),
                "invalid-device-lease", "device owner and unique physical UUIDs are required")
        with lock(self.root / "device-leases.lock"):
            data = self._read(); key = digest_json(owner)
            if key in data["owners"]:
                entry = self._entry(data, owner)
                require(entry["devices"] == sorted(devices) and "releasedAt" not in entry and not entry["closing"],
                        "device-lease-conflict", "cannot revive or change an existing device lease")
                self._charge(entry); atomic_json(self.path, data)
                return entry
            for entry in data["owners"].values():
                require("releasedAt" in entry or not set(entry["devices"]).intersection(devices),
                        "node-devices-reserved", "another training/evaluation owner still reserves these GPUs")
            require(not devices or not gpu_processes(devices), "node-devices-occupied", "GPU processes remain on the selected devices")
            entry = {"owner": owner, "node": self.node, "devices": sorted(devices), "acquiredAt": time.time(),
                     "processes": [], "closing": False, "gpuSeconds": 0}
            data["owners"][key] = entry; atomic_json(self.path, data)
            return entry

    def track(self, owner, identities, *, launching=False):
        with lock(self.root / "device-leases.lock"):
            data = self._read(); entry = self._entry(data, owner)
            require("releasedAt" not in entry and (not launching or not entry["closing"]),
                    "device-lease-fenced", "process launch is fenced by device release")
            known = {digest_json(i): i for i in entry["processes"]}
            known.update({digest_json(i): i for i in identities})
            entry["processes"] = list(known.values()); self._charge(entry); atomic_json(self.path, data)

    def fence(self, owner):
        with lock(self.root / "device-leases.lock"):
            data = self._read(); entry = self._entry(data, owner)
            entry["closing"] = True; self._charge(entry); atomic_json(self.path, data)

    def inspect(self, owner):
        with lock(self.root / "device-leases.lock"):
            data = self._read(); entry = self._entry(data, owner)
            self._charge(entry); atomic_json(self.path, data)
            return entry

    def exists(self, owner):
        with lock(self.root / "device-leases.lock"):
            return digest_json(owner) in self._read()["owners"]

    def has_owners(self, prefix):
        with lock(self.root / "device-leases.lock"):
            return any(entry["owner"].startswith(prefix) for entry in self._read()["owners"].values())

    def verify_active(self, owner, devices, required_processes):
        """Read-only admission for reattaching an existing live engine."""
        with lock(self.root / "device-leases.lock"):
            entry = self._entry(self._read(), owner)
            require(not entry["closing"] and "releasedAt" not in entry and entry["devices"] == sorted(devices),
                    "device-lease-fenced", "active service device ownership is not intact")
            require(required_processes and all(p in entry["processes"] and owned_alive(p) for p in required_processes),
                    "inference-process-unconfirmed", "supervisor or engine process identity is no longer live and owned")
            if devices:
                live = {p["pid"] for p in entry["processes"] if owned_alive(p)}
                used = gpu_processes(devices)
                require({row["device"] for row in used} == set(devices) and all(row["pid"] in live for row in used),
                        "inference-gpu-unconfirmed", "GPU compute ownership is not confirmed for the active service")

    def gpu_seconds(self, prefix):
        with lock(self.root / "device-leases.lock"):
            data = self._read(); total = 0
            for entry in data["owners"].values():
                if entry["owner"].startswith(prefix):
                    self._charge(entry); total += entry["gpuSeconds"]
            atomic_json(self.path, data)
            return total

    def release(self, owner):
        with lock(self.root / "device-leases.lock"):
            data = self._read(); entry = self._entry(data, owner)
            if "releasedAt" in entry: return True
            require(entry["closing"], "device-lease-open", "fence process launches before releasing devices")
            released = not any(owned_alive(i) for i in entry["processes"]) and (not entry["devices"] or not gpu_processes(entry["devices"]))
            if released: entry["releasedAt"] = time.time()
            self._charge(entry); atomic_json(self.path, data)
            return released

    def reconcile_previous_generation(self):
        # A boot generation is backed by the OS boot ID. Old PIDs are never
        # interpreted in the new boot; unknown GPU occupants still block release.
        with lock(self.root / "device-leases.lock"):
            data = self._read()
            for entry in data["owners"].values():
                if entry["node"] == self.node or "releasedAt" in entry: continue
                previous_boot_proof(self.root, self.node, entry["node"])
                if entry["devices"] and gpu_processes(entry["devices"]): continue
                entry.update(closing=True, releasedAt=time.time()); self._charge(entry)
            atomic_json(self.path, data)

    def release_previous_owner(self, owner, previous_node, *, allow_missing=False):
        # Never signal or inspect a numeric PID from another OS boot.
        with lock(self.root / "device-leases.lock"):
            data = self._read()
            proof = previous_boot_proof(self.root, self.node, previous_node)
            entry = data["owners"].get(digest_json(owner))
            if entry is None:
                require(allow_missing, "previous-device-lease-missing", "launched service lost its device ownership evidence")
                return {"devices": [], "gpuSeconds": 0, **proof}
            require(entry["owner"] == owner and entry["node"] == previous_node,
                    "device-owner-mismatch", "recovery cannot release another owner or generation")
            if "releasedAt" not in entry:
                require(not entry["devices"] or not gpu_processes(entry["devices"]),
                        "node-devices-occupied", "physical GPU occupants prevent prior generation release")
                entry.update(closing=True, releasedAt=time.time())
                self._charge(entry); atomic_json(self.path, data)
            return {"devices": entry["devices"], "gpuSeconds": entry["gpuSeconds"], **proof}

    def previous_owner_released(self, owner, previous_node, *, allow_missing=False):
        with lock(self.root / "device-leases.lock"):
            entry = self._read()["owners"].get(digest_json(owner))
            return allow_missing if entry is None else (entry["owner"] == owner and entry["node"] == previous_node and "releasedAt" in entry)
