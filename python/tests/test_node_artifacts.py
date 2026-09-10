import json
import struct
import tempfile
import unittest
from pathlib import Path

from gear_training.content import ContentStore, ContractError, digest_json
from gear_training.export import seal_directory
from gear_training.node_artifacts import hf_manifest


class NodeHfManifestTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.store = ContentStore(self.root / "cas")
        self.model = self.root / "model"; self.model.mkdir()
        self.config = {"architectures": ["Qwen2ForCausalLM"], "model_type": "qwen2", "torch_dtype": "float32", "max_position_embeddings": 128}
        (self.model / "config.json").write_text(json.dumps(self.config))
        (self.model / "tokenizer_config.json").write_text(json.dumps({"chat_template": "{{ messages }}"}))
        (self.model / "tokenizer.json").write_text("{}")
        header = json.dumps({"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
        (self.model / "model.safetensors").write_bytes(struct.pack("<Q", len(header)) + header + struct.pack("<f", 1))
        self.snapshot = seal_directory(self.store, self.model, serving=True)

    def test_observes_real_node_files_without_local_hitch_import(self):
        model = hf_manifest(self.store, {"snapshotRef": self.snapshot})
        body = {key: model[key] for key in ("format", "files", "architecture", "model_type", "dtype", "quantization", "context_tokens", "tokenizer_digest", "template_digest")}
        self.assertEqual(model["model_id"], digest_json(body))
        self.assertEqual(model["architecture"], "Qwen2ForCausalLM")
        self.assertEqual(len(model["files"]), 4)
        self.assertEqual(model["source"]["kind"], "local-directory")

    def test_rejects_snapshot_semantics_that_disagree_with_actual_config(self):
        manifest = self.store.read_json(self.snapshot); manifest["architecture"] = "ForgedArchitecture"
        with self.assertRaisesRegex(ContractError, "differs from actual files"):
            hf_manifest(self.store, {"snapshotRef": self.store.put_json(manifest)})

    def test_rejects_corrupted_model_file(self):
        manifest = self.store.read_json(self.snapshot)
        weight = next(item for item in manifest["files"] if item["path"].endswith(".safetensors"))
        self.store.path(weight["sha256"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ContractError, "failed verification"):
            hf_manifest(self.store, {"snapshotRef": self.snapshot})

    def test_rejects_dynamic_code_even_when_no_files_are_downloaded(self):
        # The older seal permitted an empty auto_map, but serving registration
        # must preserve Hitch's stricter no-dynamic-code boundary.
        (self.model / "config.json").write_text(json.dumps({**self.config, "auto_map": {}}))
        snapshot = seal_directory(self.store, self.model, serving=True)
        with self.assertRaisesRegex(ContractError, "dynamic code"):
            hf_manifest(self.store, {"snapshotRef": snapshot})


if __name__ == "__main__": unittest.main()
