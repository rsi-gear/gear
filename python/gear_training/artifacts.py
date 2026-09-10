"""Public, CPU-capable snapshot RPC used by Gear; never mutates Hitch stores."""
from __future__ import annotations

import argparse
import json
import sys
from .content import ContentStore, digest_json, require
from .export import dataset_destination, materialize, seal_directory


def seal_hf(store, directory):
    ref = seal_directory(store, directory, serving=True, verify_finite=True)
    manifest = store.read_json(ref)
    provenance = store.put_json({"schemaVersion": 1, "kind": "initial-hf-import", "snapshotRef": ref})
    body = {"schemaVersion": 1, "hfSnapshotRef": ref, "provenanceRef": provenance,
            **{k: manifest[k] for k in ("weightsDigest", "tokenizerDigest", "chatTemplateDigest", "architecture", "dtype")}}
    model = {**body, "id": digest_json(body)}
    return {"model": model, "modelRef": store.put_json(model)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("materialize", "seal-hf", "seal-dataset"))
    parser.add_argument("--store-root", required=True)
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        store = ContentStore(args.store_root)
        if args.action == "materialize":
            destination = dataset_destination(store.read_json(payload["ref"]), payload["destination"])
            result = {"path": str(materialize(store, payload["ref"], destination))}
        else:
            hf = args.action == "seal-hf"
            if hf:
                result = seal_hf(store, payload["directory"])
            else:
                ref = seal_directory(store, payload["directory"], dataset=True)
                manifest = store.read_json(ref)
                require(any(f["path"].endswith("task.toml") for f in manifest["files"]), "not-harbor-dataset", "dataset must contain Harbor task.toml files")
                result = {"snapshotRef": ref}
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": {"code": getattr(error, "code", "artifact-error"), "message": str(error)}}))
        sys.exit(1)


if __name__ == "__main__": main()
