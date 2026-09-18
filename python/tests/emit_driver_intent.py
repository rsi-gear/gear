"""Cross-language fixture: real driver lease and node journal, no GPU execution."""
import json
import sys
import tempfile
from pathlib import Path

from gear_training.content import ContentStore, atomic_json, digest_bytes
from gear_training.driver import create_policy_lease
from gear_training.episodes import EpisodeJournal
from gear_training.ledger import Ledger


data = json.load(sys.stdin)
request, old = data["request"], data["intent"]
context, binding = old["context"], old["binding"]
lease = create_policy_lease(request, context["batchId"], context["policyVersion"],
                            old["lease"]["synchronizedWeightsRef"], context["runtimeInstanceId"])
with tempfile.TemporaryDirectory() as root:
    directory = Path(root) / old["jobId"]
    store = ContentStore(Path(root) / "content")
    binding.update(policyLeaseRef=store.put_json(lease), fencingToken=lease["fencingToken"], expiresAt=lease["expiresAt"])
    atomic_json(directory / "request.json", request)
    atomic_json(directory / "config.json", {"schemaVersion": 2, "storeRoot": str(store.root)})
    atomic_json(directory / "worker.json", {"incarnation": old["incarnation"]})
    ledger = Ledger(directory / "ledger.sqlite")
    try:
        ledger.open_lease(lease, [{"replicaId": "cpu-boundary-fixture", "weightsDigest": lease["synchronizedWeightsRef"]["digest"],
                                 "runtimeInstanceId": lease["runtimeInstanceId"], "policyVersion": lease["policyVersion"]}])
        ledger.register_episode(context, digest_bytes(old["credential"].encode()))
        journal = EpisodeJournal(directory, ledger)
        intent = journal.publish(context, binding, old["credential"], old["gateway"]["nodePort"])
        assert journal.list()["entries"][0]["intent"] == intent
        print(json.dumps(intent))
    finally:
        ledger.close()
