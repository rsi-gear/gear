"""Import immutable model snapshots without running a CLI or training job."""

from gear.training.storage.content import digest_json
from gear.training.storage.snapshots import seal_directory


def seal_hf(store, directory):
    ref = seal_directory(store, directory, serving=True, verify_finite=True)
    manifest = store.read_json(ref)
    provenance = store.put_json(
        {"schemaVersion": 1, "kind": "initial-hf-import", "snapshotRef": ref}
    )
    body = {
        "schemaVersion": 1,
        "hfSnapshotRef": ref,
        "provenanceRef": provenance,
        **{
            k: manifest[k]
            for k in (
                "weightsDigest",
                "tokenizerDigest",
                "chatTemplateDigest",
                "architecture",
                "dtype",
            )
        },
    }
    model = {**body, "id": digest_json(body)}
    return {"model": model, "modelRef": store.put_json(model)}
