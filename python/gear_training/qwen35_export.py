"""Keep frozen Qwen3.5 vision and disabled MTP weights in language-only exports."""
import json
import os
from pathlib import Path
import struct

from .content import atomic_json, require
from .export import safetensors_layout


def preserve_frozen_auxiliary(parent, exported, *, mtp_num_layers=0):
    parent, exported = Path(parent), Path(exported)
    config = json.loads((parent / "config.json").read_text())
    if config.get("model_type") != "qwen3_5" or "vision_config" not in config:
        return
    require(json.loads((exported / "config.json").read_text()) == config,
            "export-semantics-drift", "composite model configuration changed")

    def inventory(directory):
        tensors, sources, total = {}, {}, 0
        for file in sorted(directory.glob("*.safetensors")):
            layout = safetensors_layout(file)
            with file.open("rb") as stream:
                header_size = struct.unpack("<Q", stream.read(8))[0]
                header = json.loads(stream.read(header_size))
            for name, description in layout.items():
                require(name not in tensors, "duplicate-tensor-key", "duplicate export tensor")
                tensors[name] = description
                start, end = header[name]["data_offsets"]
                sources[name] = (file, 8 + header_size + start, end - start)
                total += end - start
        return tensors, sources, total

    original, sources, _ = inventory(parent)
    actual, _, total = inventory(exported)
    require(actual and set(actual) <= set(original), "export-tensor-drift", "unexpected Qwen3.5 export tensors")
    require(all(actual[k]["shape"] == original[k]["shape"] for k in actual),
            "export-tensor-drift", "Qwen3.5 export tensor shape changed")
    missing = sorted(set(original) - set(actual))
    require(all(name.startswith("model.visual.") or (not mtp_num_layers and name.startswith("mtp.")) for name in missing),
            "incomplete-language-export", "cannot replace missing trained language weights with parent weights")
    if not missing:
        return
    filename = "gear-frozen-auxiliary.safetensors"
    target = exported / filename
    header, offset = {}, 0
    for name in missing:
        size = sources[name][2]
        header[name] = {**original[name], "data_offsets": [offset, offset + size]}
        offset += size
    data = json.dumps(header, separators=(",", ":")).encode()
    data += b" " * (-len(data) % 8)
    # Stream immutable parent bytes, without an extra full auxiliary-model copy in RAM.
    with target.open("xb") as output:
        output.write(struct.pack("<Q", len(data))); output.write(data)
        for name in missing:
            source, start, remaining = sources[name]
            with source.open("rb") as stream:
                stream.seek(start)
                while remaining:
                    chunk = stream.read(min(remaining, 1024 * 1024))
                    require(chunk, "incomplete-weights", "frozen auxiliary tensor was truncated")
                    output.write(chunk); remaining -= len(chunk)
        output.flush(); os.fsync(output.fileno())
    safetensors_layout(target)
    index_path = exported / "model.safetensors.index.json"
    index = json.loads(index_path.read_text())
    require(set(index["weight_map"]) == set(actual), "export-index-drift", "export index differs from written tensors")
    index["weight_map"].update({name: filename for name in missing})
    index.setdefault("metadata", {})["total_size"] = total + offset
    atomic_json(index_path, index)
