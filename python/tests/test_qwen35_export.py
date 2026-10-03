import json
from pathlib import Path
import struct
import tempfile
import unittest

from gear_training.content import ContractError
from gear_training.export import safetensors_layout
from gear_training.qwen35_export import preserve_frozen_auxiliary


def weights(path, values):
    header, payload = {}, b""
    for name, value in values.items():
        header[name] = {"dtype": "F32", "shape": [1], "data_offsets": [len(payload), len(payload) + 4]}
        payload += struct.pack("<f", value)
    encoded = json.dumps(header).encode(); encoded += b" " * (-len(encoded) % 8)
    path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + payload)


class Qwen35ExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name) / "parent"; self.parent.mkdir()
        self.export = Path(temporary.name) / "export"; self.export.mkdir()
        config = {"model_type": "qwen3_5", "vision_config": {}, "text_config": {}}
        for directory in (self.parent, self.export):
            (directory / "config.json").write_text(json.dumps(config))
        self.language = "model.language_model.layers.0.weight"
        self.vision = "model.visual.blocks.0.weight"
        weights(self.parent / "model.safetensors", {self.language: 1, self.vision: 3})
        weights(self.export / "model.safetensors", {self.language: 2})
        (self.export / "model.safetensors.index.json").write_text(json.dumps({
            "metadata": {"total_size": 4}, "weight_map": {self.language: "model.safetensors"}}))

    def test_preserves_frozen_vision_and_keeps_updated_language(self):
        before = (self.export / "model.safetensors").read_bytes()
        preserve_frozen_auxiliary(self.parent, self.export)
        self.assertEqual((self.export / "model.safetensors").read_bytes(), before)
        frozen = self.export / "gear-frozen-auxiliary.safetensors"
        self.assertEqual(set(safetensors_layout(frozen)), {self.vision})
        self.assertEqual(frozen.read_bytes()[-4:], struct.pack("<f", 3))
        index = json.loads((self.export / "model.safetensors.index.json").read_text())
        self.assertEqual(index["weight_map"], {self.language: "model.safetensors", self.vision: frozen.name})
        self.assertEqual(index["metadata"]["total_size"], 8)
        preserve_frozen_auxiliary(self.parent, self.export)

    def test_missing_language_weights_fail_without_parent_substitution(self):
        weights(self.parent / "model.safetensors", {self.language: 1, self.vision: 3, "model.language_model.missing": 4})
        with self.assertRaisesRegex(ContractError, "missing trained language"):
            preserve_frozen_auxiliary(self.parent, self.export)
        self.assertFalse((self.export / "gear-frozen-auxiliary.safetensors").exists())

    def test_flat_model_export_is_unchanged(self):
        (self.parent / "config.json").write_text('{"model_type":"qwen2"}')
        preserve_frozen_auxiliary(self.parent, self.export)
        self.assertFalse((self.export / "gear-frozen-auxiliary.safetensors").exists())

    def test_config_drift_is_rejected(self):
        (self.export / "config.json").write_text('{"model_type":"qwen3_5"}')
        with self.assertRaisesRegex(ContractError, "configuration changed"):
            preserve_frozen_auxiliary(self.parent, self.export)

    def test_missing_enabled_mtp_weights_fail(self):
        weights(self.parent / "model.safetensors", {self.language: 1, self.vision: 3, "mtp.fc.weight": 4})
        with self.assertRaisesRegex(ContractError, "missing trained language"):
            preserve_frozen_auxiliary(self.parent, self.export, mtp_num_layers=1)

    def test_disabled_mtp_is_preserved_with_frozen_vision(self):
        weights(self.parent / "model.safetensors", {self.language: 1, self.vision: 3, "mtp.fc.weight": 4})
        preserve_frozen_auxiliary(self.parent, self.export, mtp_num_layers=0)
        layout = safetensors_layout(self.export / "gear-frozen-auxiliary.safetensors")
        self.assertEqual(set(layout), {self.vision, "mtp.fc.weight"})
