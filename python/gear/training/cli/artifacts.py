"""Public, CPU-capable snapshot RPC used by Gear; never mutates Hitch stores."""

from __future__ import annotations

import argparse
import json
import sys

from gear.training.storage.content import ContentStore, require
from gear.training.storage.models import seal_hf
from gear.training.storage.snapshots import dataset_destination, materialize, seal_directory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("materialize", "seal-hf", "seal-dataset", "seal-sft"))
    parser.add_argument("--store-root", required=True)
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        store = ContentStore(args.store_root)
        if args.action == "seal-sft":
            from gear.training.data.offline import seal_dataset

            result = seal_dataset(store, payload)
        elif args.action == "materialize":
            destination = dataset_destination(
                store.read_json(payload["ref"]), payload["destination"]
            )
            result = {"path": str(materialize(store, payload["ref"], destination))}
        else:
            hf = args.action == "seal-hf"
            if hf:
                result = seal_hf(store, payload["directory"])
            else:
                ref = seal_directory(store, payload["directory"], dataset=True)
                manifest = store.read_json(ref)
                require(
                    any(f["path"].endswith("task.toml") for f in manifest["files"]),
                    "not-harbor-dataset",
                    "dataset must contain Harbor task.toml files",
                )
                result = {"snapshotRef": ref}
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": getattr(error, "code", "artifact-error"),
                        "message": str(error),
                    }
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
