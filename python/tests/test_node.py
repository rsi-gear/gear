from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, digest_bytes, digest_json
from gear_training.node import NodeService, dependency_refs


class NodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.config = {"schemaVersion": 2, "nodeId": "gpu-node", "nodeRoot": self.tmp.name + "/node", "storeRoot": self.tmp.name + "/content", "jobConfigPath": self.tmp.name + "/job.json"}
        with patch("gear_training.node.boot_identity", return_value="boot-1"): self.node = NodeService(self.config)

    def envelope(self, operation, payload):
        return {"schemaVersion": 2, "requestId": "request-1", "node": self.node.identity, "operation": operation, "inputDigest": digest_json(payload), "payload": payload}

    def test_generation_survives_reconnect_but_changes_on_reboot(self):
        with patch("gear_training.node.boot_identity", return_value="boot-1"): same = NodeService(self.config)
        self.assertEqual(same.identity, self.node.identity)
        envelope = self.envelope("cas.stat", {"digest": digest_bytes(b"none")})
        with patch("gear_training.node.boot_identity", return_value="boot-2"): reboot = NodeService(self.config)
        self.assertNotEqual(reboot.identity, self.node.identity)
        with self.assertRaisesRegex(ContractError, "generation changed"): reboot.rpc(envelope)

    def test_truncated_corrupt_and_oversized_transfers_never_publish(self):
        content = b"exact-weights"; digest = digest_bytes(content)
        envelope = self.envelope("cas.import", {"digest": digest, "size": len(content)})
        for body in (content[:-1], b"x" * len(content), content + b"extra"):
            with self.subTest(body=body), self.assertRaises(ContractError): self.node.import_stream(envelope, io.BytesIO(body))
            self.assertFalse(self.node.store.path(digest).exists())
            self.assertEqual(list(Path(self.config["storeRoot"]).rglob('*.incoming')), [])
        self.node.import_stream(envelope, io.BytesIO(content))
        self.node.import_stream(envelope, io.BytesIO(content))
        self.assertEqual(self.node.store.path(digest).read_bytes(), content)
        output = io.BytesIO()
        self.node.export_stream(self.envelope("cas.export", {"digest": digest}), output)
        header, raw = output.getvalue().split(b"\n", 1)
        self.assertEqual(json.loads(header)["node"], self.node.identity)
        self.assertEqual(raw, content)

    def test_corrupt_existing_object_and_envelope_mismatch_are_rejected(self):
        ref = self.node.store.put_bytes(b"original", "application/octet-stream")
        envelope = self.envelope("cas.stat", {"digest": ref["digest"]})
        self.node.store.path(ref["digest"]).write_bytes(b"changed")
        with self.assertRaisesRegex(ContractError, "corrupt"): self.node.rpc(envelope)
        envelope["payload"] = {"digest": digest_bytes(b"another")}
        with self.assertRaisesRegex(ContractError, "input digest"): self.node.rpc(envelope)

    def test_cas_graph_references_are_portable_not_controller_paths(self):
        ref = self.node.store.put_json({"tensor": "descriptor"})
        self.assertEqual(dependency_refs({"first": ref, "nested": [ref]}), [ref])
        with self.assertRaisesRegex(ContractError, "portable CAS"):
            dependency_refs({"private": {**ref, "uri": "file:///controller/private"}})


if __name__ == "__main__": unittest.main()
