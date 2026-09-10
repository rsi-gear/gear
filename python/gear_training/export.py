"""Seal HF exports and complete trainer states without a circular manifest."""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import uuid
from pathlib import Path
from .content import require, digest_bytes, digest_json, digest_file, sync_dir


DTYPE_BYTES = {"BOOL": 1, "I8": 1, "U8": 1, "I16": 2, "U16": 2, "F16": 2, "BF16": 2, "I32": 4, "U32": 4, "F32": 4, "I64": 8, "U64": 8, "F64": 8}


def safetensors_layout(path):
    size = path.stat().st_size
    with path.open("rb") as f:
        raw = f.read(8)
        require(len(raw) == 8, "incomplete-safetensors", "safetensors header is missing")
        header_size = struct.unpack("<Q", raw)[0]
        require(2 <= header_size <= min(size - 8, 100_000_000), "invalid-safetensors-header", "invalid tensor header length")
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, "duplicate-tensor-key", "duplicate safetensors header key")
                result[key] = value
            return result
        header = json.loads(f.read(header_size), object_pairs_hook=unique)
    tensors, spans = {}, []
    for name, tensor in header.items():
        if name == "__metadata__":
            continue
        require(isinstance(tensor, dict) and set(tensor) == {"dtype", "shape", "data_offsets"}, "invalid-tensor", "invalid tensor header fields")
        require(tensor["dtype"] in DTYPE_BYTES and isinstance(tensor["shape"], list) and all(type(x) is int and x >= 0 for x in tensor["shape"]), "invalid-tensor-shape", "unsupported dtype or shape")
        offsets = tensor["data_offsets"]
        require(isinstance(offsets, list) and len(offsets) == 2 and all(type(x) is int and x >= 0 for x in offsets), "invalid-tensor-offsets", "invalid tensor offsets")
        count = 1
        for dimension in tensor["shape"]:
            count *= dimension
        require(offsets[1] - offsets[0] == count * DTYPE_BYTES[tensor["dtype"]] and offsets[1] <= size - 8 - header_size,
                "incomplete-tensor", "tensor bytes do not match declared dtype and shape")
        tensors[name] = {"dtype": tensor["dtype"], "shape": tensor["shape"]}
        spans.append(tuple(offsets))
    end = 0
    for start, stop in sorted(spans):
        require(start == end, "invalid-tensor-layout", "tensor spans overlap or leave gaps")
        end = stop
    require(tensors and end == size - 8 - header_size, "incomplete-weights", "safetensors payload has missing or unclaimed bytes")
    return tensors


def seal_directory(store, directory, serving=False, verify_finite=False, dataset=False):
    root = Path(directory).resolve()
    require(root.is_dir(), "missing-export", "export directory does not exist")
    require(not (dataset and serving), "invalid-snapshot-kind", "dataset and model snapshots are distinct")
    files, directories, tensors, weights = [], [], {}, []
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "export-symlink", "sealed exports cannot contain symlinks")
        if path.is_dir():
            if dataset: directories.append({"path": path.relative_to(root).as_posix(), "mode": path.stat().st_mode & 0o7777})
            continue
        require(path.is_file(), "export-special-file", "only regular files can be sealed")
        name = path.relative_to(root).as_posix()
        if serving:
            require(not re.search(r"\.(bin|pt|pth|pkl|pickle|py|so|dylib|dll)$", name, re.I), "unsafe-serving-export", "trainer state and executable code do not belong in HF serving snapshots")
        before = path.stat()
        if serving and name.endswith(".safetensors"):
            layout = safetensors_layout(path)
            require(not set(tensors).intersection(layout), "duplicate-tensor", "tensor occurs in more than one HF shard")
            tensors.update({k: {**v, "file": name} for k, v in layout.items()})
            if verify_finite:
                from safetensors import safe_open
                import torch
                with safe_open(str(path), framework="pt", device="cpu") as f:
                    for key in f.keys():
                        tensor = f.get_tensor(key)
                        require(bool(torch.isfinite(tensor).all()), "non-finite-weights", "HF export contains NaN/Inf: " + key)
        ref = store.put_file(path)
        after = path.stat()
        require((before.st_size, before.st_mtime_ns, before.st_mode) == (after.st_size, after.st_mtime_ns, after.st_mode), "export-still-writing", "export changed during sealing")
        entry = {"path": name, "size": before.st_size, "sha256": ref["digest"], "contentRef": ref}
        if dataset: entry["mode"] = before.st_mode & 0o7777
        files.append(entry)
        if name.endswith(".safetensors"):
            weights.append({"path": name, "sha256": ref["digest"]})
    require(files, "empty-export", "cannot seal an empty export")
    manifest = {"schemaVersion": 1, "format": "hf-safetensors" if serving else "trainer-files", "files": files}
    if dataset:
        manifest.update(schemaVersion=2, format="harbor-dataset", name=root.name,
                        mode=root.stat().st_mode & 0o7777, directories=directories)
    if serving:
        names = {f["path"] for f in files}
        require("config.json" in names and "tokenizer_config.json" in names and ("tokenizer.json" in names or "tokenizer.model" in names) and weights, "incomplete-hf-export", "HF snapshot requires weights, config, tokenizer and template")
        config = json.loads((root / "config.json").read_text())
        token_config = json.loads((root / "tokenizer_config.json").read_text())
        require(not config.get("auto_map") and not token_config.get("auto_map") and not config.get("quantization_config"), "model-code-or-quantization", "v1 requires a dense safetensors model without dynamic code or quantization")
        template = (root / "chat_template.jinja").read_text() if (root / "chat_template.jinja").exists() else token_config.get("chat_template")
        require(isinstance(template, str) and template, "missing-chat-template", "one explicit chat template is required")
        architecture = (config.get("architectures") or [None])[0]
        dtype = config.get("torch_dtype", config.get("dtype"))
        require(isinstance(architecture, str) and isinstance(dtype, str), "invalid-model-config", "model config must declare architecture and dtype")
        index_path = root / "model.safetensors.index.json"
        if index_path.exists():
            mapping = json.loads(index_path.read_text()).get("weight_map")
            require(isinstance(mapping, dict) and set(mapping) == set(tensors) and all(tensors[k]["file"] == file for k, file in mapping.items()), "invalid-shard-index", "HF shard index must cover every tensor exactly")
        elif len(weights) != 1:
            require(False, "missing-shard-index", "multiple safetensors shards require an index")
        tokenizer_files = [{"path": f["path"], "sha256": f["sha256"]} for f in files if re.search(r"(?:^|/)(?:tokenizer|special_tokens_map|added_tokens|tokenizer_config)(?:\.|$)", f["path"])]
        manifest.update({"weightsDigest": digest_json(weights), "tokenizerDigest": digest_json(tokenizer_files), "chatTemplateDigest": digest_bytes(template.encode()),
                         "architecture": architecture, "dtype": dtype, "tensorLayoutDigest": digest_json(tensors)})
    return store.put_json(manifest)


def dataset_destination(manifest, destination):
    if manifest.get("schemaVersion") != 2 or manifest.get("format") != "harbor-dataset": return Path(destination)
    name = manifest.get("name")
    require(isinstance(name, str) and name not in ("", ".", "..") and "/" not in name and "\\" not in name and "\0" not in name,
            "invalid-dataset-name", "dataset name must be one path component")
    return Path(destination) / name


def materialize(store, ref, destination):
    manifest = store.read_json(ref)
    dataset = manifest.get("schemaVersion") == 2 and manifest.get("format") == "harbor-dataset"
    require(dataset or manifest.get("schemaVersion") == 1 and manifest.get("format") in ("hf-safetensors", "trainer-files", "harbor-dataset"), "invalid-file-manifest", "unknown snapshot format")
    destination = Path(destination)
    seen = set()
    directories = manifest.get("directories") if dataset else []
    if dataset:
        dataset_destination(manifest, destination)
        require(isinstance(directories, list), "invalid-file-manifest", "dataset directories are missing")
    def valid_mode(mode): return type(mode) is int and 0 <= mode <= 0o7777
    if dataset: require(valid_mode(manifest.get("mode")), "invalid-file-manifest", "dataset root mode is invalid")
    require(isinstance(manifest.get("files"), list) and manifest["files"], "invalid-file-manifest", "snapshot files are missing")
    for item in manifest["files"]:
        name = item["path"]
        require(isinstance(name, str) and name not in seen and "\\" not in name and not Path(name).is_absolute()
                and all(p not in ("", ".", "..") for p in name.split("/")), "invalid-export-path", "file manifest path escapes or duplicates the snapshot")
        require(item["sha256"] == item["contentRef"]["digest"] and type(item["size"]) is int and item["size"] >= 0,
                "invalid-export-file", "file identity or size mismatch")
        if dataset: require(valid_mode(item.get("mode")), "invalid-file-manifest", "dataset file mode is invalid")
        seen.add(name)
    directory_names = set()
    for item in directories:
        name = item["path"]
        require(isinstance(name, str) and name not in seen and name not in directory_names and "\\" not in name
                and not Path(name).is_absolute() and all(p not in ("", ".", "..") for p in name.split("/"))
                and valid_mode(item.get("mode")), "invalid-export-path", "dataset directory path or mode is invalid")
        directory_names.add(name)
    if dataset:
        for name in seen | directory_names:
            require(all(str(parent) in directory_names for parent in Path(name).parents if str(parent) != "."),
                    "invalid-file-manifest", "dataset parent directory is missing")
    if destination.exists():
        require(destination.is_dir() and not destination.is_symlink(), "materialization-drift", "snapshot root must be a directory")
        actual, actual_directories = set(), set()
        for path in destination.rglob("*"):
            require(not path.is_symlink(), "materialization-drift", "snapshot cannot contain symlinks")
            if path.is_dir(): actual_directories.add(path.relative_to(destination).as_posix())
            else: actual.add(path.relative_to(destination).as_posix())
        require(actual == seen, "materialization-drift", "snapshot has missing or unexpected files")
        if dataset:
            require(actual_directories == directory_names and destination.stat().st_mode & 0o7777 == manifest["mode"],
                    "materialization-drift", "dataset directories or root permissions changed")
            for item in directories:
                require((destination / item["path"]).stat().st_mode & 0o7777 == item["mode"],
                        "materialization-drift", "dataset directory permissions changed")
        for item in manifest["files"]:
            path = destination / item["path"]
            require(path.is_file() and path.stat().st_size == item["size"] and digest_file(path) == item["sha256"],
                    "materialization-drift", "existing snapshot differs from sealed content")
            if dataset: require(path.stat().st_mode & 0o7777 == item["mode"], "materialization-drift", "dataset file permissions changed")
        return destination
    temp = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    temp.mkdir(parents=True, mode=0o700)
    def restore_mode(path, mode):
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fchmod(fd, mode); os.fsync(fd)
        finally: os.close(fd)
    try:
        for item in directories: (temp / item["path"]).mkdir(parents=True, exist_ok=True)
        for item in manifest["files"]:
            path = temp / item["path"]; path.parent.mkdir(parents=True, exist_ok=True)
            store.copy_ref(item["contentRef"], path)
            require(path.stat().st_size == item["size"], "invalid-export-file", "file manifest size mismatch")
            if dataset: restore_mode(path, item["mode"])
        for directory in sorted((p for p in temp.rglob("*") if p.is_dir()), reverse=True): sync_dir(directory)
        sync_dir(temp)
        if dataset:
            for item in sorted(directories, key=lambda item: len(Path(item["path"]).parts), reverse=True):
                restore_mode(temp / item["path"], item["mode"])
            restore_mode(temp, manifest["mode"])
        os.rename(temp, destination); sync_dir(destination.parent)
    finally:
        if temp.exists(): shutil.rmtree(temp)
    return destination


def commit_checkpoint(store, ledger, *, request, committed_update, trainer_directory, hf_directory, data_cursor, rng_state_ref, compatibility_digest, batch_ref, previous_commit=None, trainer_state_ref=None):
    # Called only after the pinned backend's synchronous save_model returns.
    # The driver already sealed this complete snapshot before publishing its
    # pending-update journal. Reuse those immutable bytes, including on recovery,
    # instead of scanning a mutable backend save directory a second time.
    actor_ref = trainer_state_ref if trainer_state_ref is not None else seal_directory(store, trainer_directory)
    trainer = store.read_json(actor_ref)
    require(actor_ref["uri"] == "cas:" + actor_ref["digest"] and trainer.get("schemaVersion") == 1
            and trainer.get("format") == "trainer-files" and isinstance(trainer.get("files"), list) and trainer["files"],
            "invalid-trainer-snapshot", "checkpoint requires a sealed complete trainer file manifest")
    require(actor_ref == rng_state_ref, "trainer-state-mismatch", "actor, optimizer and RNG must use the same synchronous trainer snapshot")
    hf_ref = seal_directory(store, hf_directory, serving=True, verify_finite=True)
    hf = store.read_json(hf_ref)
    parent = request["parentModel"]
    for key in ("tokenizerDigest", "chatTemplateDigest", "architecture", "dtype"):
        require(hf[key] == parent[key], "export-semantics-drift", "weight-only candidate changed " + key)
    cursor_ref = store.put_json(data_cursor)
    checkpoint = {"schemaVersion": 1, "actorWeightsDigest": hf["weightsDigest"], "hfExportRef": hf_ref,
                  "actorStateRef": actor_ref, "optimizerStateRef": actor_ref, "schedulerAndRngRef": rng_state_ref,
                  "dataCursorRef": cursor_ref, "committedUpdate": committed_update, "compatibilityDigest": compatibility_digest}
    checkpoint_ref = store.put_json(checkpoint)
    commit = {"schemaVersion": 1, "trainingRunId": request["trainingRunId"], "checkpointRef": checkpoint_ref,
              "consumedBatchDigest": batch_ref["digest"], "committedUpdate": committed_update, "rngRef": rng_state_ref, "dataCursorRef": cursor_ref}
    if previous_commit: commit["previousCommitRef"] = previous_commit
    if data_cursor.get("replayOfBatch"): commit["replayOfBatch"] = data_cursor["replayOfBatch"]
    commit_ref = store.put_json(commit)
    # This is the only durable consumed marker. Uncheckpointed memory never advances it.
    ledger.commit_update(committed_update, batch_ref["digest"], commit_ref)
    return checkpoint_ref, commit_ref
