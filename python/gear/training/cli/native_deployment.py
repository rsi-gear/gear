"""Generate the private evaluation environment lock without importing an engine."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from gear.training.storage.content import ContractError, digest_file, digest_json, require


def runtime_lock(python, supervisor_python, timeout_binary):
    from gear.training.runtime.node_runtime import package_version

    root = str(Path(__file__).resolve().parents[3])
    code = (
        "import json,sys;from pathlib import Path;root=" + repr(root) + ";"
        "sys.path.insert(0,root) if root not in [str(Path(p).resolve()) for p in sys.path] else None;"
        "from gear.training.runtime.node_runtime import observe_startup_runtime;"
        "print(json.dumps(observe_startup_runtime()))"
    )
    runtime = json.loads(subprocess.check_output([python, "-c", code], text=True, timeout=30))
    sglang = package_version(runtime, "sglang")
    require(
        sglang is not None,
        "native-engine-missing",
        "install the pinned SGLang evaluation environment before creating its lock",
    )
    supervisor = subprocess.check_output(
        [
            supervisor_python,
            "-c",
            "import importlib.metadata;print(importlib.metadata.version('supervisor'))",
        ],
        text=True,
        timeout=15,
    ).strip()
    require(
        "GNU coreutils"
        in subprocess.check_output([timeout_binary, "--version"], text=True, timeout=5),
        "native-deadline-tool-drift",
        "native deployment requires GNU timeout",
    )
    return {
        "environmentDigest": digest_json(runtime),
        "pythonVersion": runtime["pythonVersion"],
        "sglangVersion": sglang,
        "supervisorVersion": supervisor,
        "timeoutBinary": str(Path(timeout_binary).absolute()),
        "timeoutDigest": digest_file(timeout_binary),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("runtime-lock",))
    parser.add_argument("--python", required=True)
    parser.add_argument("--supervisor-python", required=True)
    parser.add_argument("--timeout", required=True)
    args = parser.parse_args()
    try:
        require(
            all(Path(p).is_absolute() for p in (args.python, args.supervisor_python, args.timeout)),
            "invalid-native-runtime",
            "native runtime executables must be absolute",
        )
        print(json.dumps(runtime_lock(args.python, args.supervisor_python, args.timeout)))
    except ContractError as error:
        print(json.dumps({"error": {"code": error.code, "message": str(error)}}))
        sys.exit(1)


if __name__ == "__main__":
    main()
