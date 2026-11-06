"""Run on the evaluation node after installing its pinned environments."""

import argparse
import json
import os
from pathlib import Path

from gear.training.cli.native_deployment import runtime_lock
from gear.training.storage.content import atomic_json, digest_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--template", default=str(Path(__file__).with_name("profile.template.json"))
    )
    parser.add_argument("--output", required=True)
    parser.add_argument("--node-identity", required=True, help="node-probe JSON output")
    parser.add_argument(
        "--sealed-model",
        required=True,
        help="seal-hf-node JSON output containing model",
    )
    parser.add_argument("--eval-gpu", action="append", required=True)
    parser.add_argument("--training-gpu", action="append", default=[])
    parser.add_argument("--python", required=True)
    parser.add_argument("--supervisor-python", required=True)
    parser.add_argument("--timeout", default="/usr/bin/timeout")
    args = parser.parse_args()
    profile = json.loads(Path(args.template).read_text())
    node = json.loads(Path(args.node_identity).read_text())
    model = json.loads(Path(args.sealed_model).read_text())["model"]
    profile["node"] = {key: node[key] for key in ("nodeId", "generation")}
    profile.update(
        gpuUuids=args.eval_gpu,
        trainingGpuUuids=args.training_gpu,
        tensorParallelSize=len(args.eval_gpu),
        python=args.python,
        supervisorPython=args.supervisor_python,
    )
    profile["runtimeLock"] = runtime_lock(
        args.python, args.supervisor_python, args.timeout
    )
    service = profile["endpoint"]["serviceConfig"]
    service.update(
        engine_version=profile["runtimeLock"]["sglangVersion"],
        engine_digest=digest_json(
            {
                "environmentDigest": profile["runtimeLock"]["environmentDigest"],
                "engineArgs": profile["engineArgs"],
            }
        ),
        tokenizer_digest=model["tokenizerDigest"],
        chat_template_digest=model["chatTemplateDigest"],
    )
    atomic_json(args.output, profile)
    os.chmod(args.output, 0o600)
    print(
        json.dumps(
            {
                "profileDigest": digest_json(profile),
                "profileFile": str(Path(args.output).absolute()),
            }
        )
    )


if __name__ == "__main__":
    main()
