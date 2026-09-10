"""Observed Python environment identity; never invent an inner OCI image."""
import importlib.metadata
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
from .content import digest_bytes, digest_json
from .preflight import bridge_digest


def observe_runtime():
    # Imports may append vendored dependencies to sys.path. Observe the same
    # interpreter's startup environment regardless of whether the caller has
    # already imported Torch. Re-read metadata on every call so an installation
    # change still invalidates the lock; do not cache or discard RECORD entries.
    root = str(Path(__file__).resolve().parent.parent)
    code = ("import json,sys; from pathlib import Path; "
            f"root={root!r}; "
            "sys.path.insert(0, root) if root not in [str(Path(p).resolve()) for p in sys.path] else None; "
            "from gear_training.node_runtime import observe_startup_runtime; "
            "print(json.dumps(observe_startup_runtime()))")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, timeout=15)
    return json.loads(result.stdout)


def observe_startup_runtime():
    """Snapshot helper for the fresh interpreter, without importing ML packages."""
    packages = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if not name: continue
        direct = distribution.read_text("direct_url.json")
        # Paths and repository credentials do not belong in the public runtime.
        vcs = json.loads(direct).get("vcs_info", {}) if direct else {}
        packages.append({"name": name.lower().replace("_", "-"), "version": distribution.version,
                         "recordDigest": digest_bytes((distribution.read_text("RECORD") or "").encode()),
                         "commit": vcs.get("commit_id")})
    packages.sort(key=lambda item: (item["name"], item["version"], item["recordDigest"]))
    return {"schemaVersion": 2, "kind": "python-env", "pythonVersion": platform.python_version(),
            "system": platform.system(), "machine": platform.machine(), "packages": packages,
            "packagesDigest": digest_json(packages), "bridgeDigest": bridge_digest(),
            "outerImageDigest": os.environ.get("GEAR_TRAINING_IMAGE_DIGEST")}


def package_version(runtime, name):
    # System and pip metadata may both describe the same version. Preserve all
    # records in the runtime identity, but only conflicting versions are ambiguous.
    versions = {p["version"] for p in runtime["packages"] if p["name"] == name}
    return next(iter(versions)) if len(versions) == 1 else None
