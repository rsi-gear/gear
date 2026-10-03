"""Sealed offline assistant supervision. No generation, rewards or behavior logprobs.

Role-token segments are an explicit operator attestation of token provenance.
Chat authoring instead uses the tokenizer's native assistant mask and fails when
its template cannot provide one. Both routes seal full aligned token roles.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from .content import ContentStore, atomic_json, digest_json, require

MAX_RECORDS = 1024
MAX_DATA_BYTES = 4 * 1024 * 1024

ROLES = {"system", "user", "assistant", "tool"}


def validate_record(record, max_tokens):
    require(isinstance(record, dict) and set(record) == {"schemaVersion", "id", "source", "tokens", "lossMask", "tokenRoles"},
            "invalid-offline-record", "SFT record contains unknown fields")
    body = {k: v for k, v in record.items() if k != "id"}
    require(record["schemaVersion"] == 1 and record["id"] == digest_json(body), "offline-record-drift", "SFT record identity differs")
    source = record["source"]
    require(isinstance(source, dict) and set(source) == {"taskId", "family", "taskDigest"}
            and all(isinstance(v, str) and v for v in source.values()), "invalid-offline-source", "SFT source must identify a sealed train task")
    tokens, mask, roles = (record[k] for k in ("tokens", "lossMask", "tokenRoles"))
    require(isinstance(tokens, list) and 1 < len(tokens) <= max_tokens and all(type(t) is int and 0 <= t < 2147483648 for t in tokens)
            and isinstance(mask, list) and isinstance(roles, list) and len(tokens) == len(mask) == len(roles)
            and mask[0] == 0 and any(m == 1 for m in mask)
            and all(type(m) is int and m in (0, 1) and r in ROLES and (m == 0 or r == "assistant") for m, r in zip(mask, roles)),
            "invalid-assistant-mask", "only assistant tokens may carry loss; first token cannot be supervised")
    return record


def model_limits(store, model):
    if not model.get("hfSnapshotRef"): return {}
    manifest = store.read_json(model["hfSnapshotRef"])
    if manifest.get("format") != "hf-safetensors": return {}
    entry = next((f for f in manifest.get("files", []) if f["path"] == "config.json"), None)
    require(entry, "offline-model-config-unavailable", "SFT requires the sealed actor model configuration")
    config = store.read_json({**entry["contentRef"], "mediaType": "application/json"})
    return {k: config[k] for k in ("vocab_size", "max_position_embeddings") if type(config.get(k)) is int and config[k] > 0}


def check_model_limits(record, limits, max_tokens):
    context = limits.get("max_position_embeddings")
    require(not context or (max_tokens <= context and len(record["tokens"]) <= context),
            "offline-context-overflow", "SFT maximum sequence exceeds sealed actor context capacity")
    vocab = limits.get("vocab_size")
    require(not vocab or all(t < vocab for t in record["tokens"]), "offline-token-out-of-vocabulary", "SFT token ID exceeds sealed actor vocabulary")


def seal_dataset(store, payload):
    require(isinstance(payload, dict) and set(payload) <= {"schemaVersion", "modelRef", "records", "maxSequenceTokens"}
            and payload.get("schemaVersion") == 1 and isinstance(payload.get("records"), list) and payload["records"]
            and type(payload.get("maxSequenceTokens")) is int and payload["maxSequenceTokens"] > 1,
            "invalid-offline-input", "seal-sft requires modelRef, maxSequenceTokens and source-labeled records")
    model = store.read_json(payload["modelRef"])
    limits = model_limits(store, model)
    tokenizer = None
    if any("messages" in row for row in payload["records"]):
        from .content import digest_bytes
        from transformers import AutoTokenizer
        import tempfile
        # Always materialize the sealed model; a mutable tokenizer directory
        # cannot borrow another model's declared token identity.
        with tempfile.TemporaryDirectory(prefix="gear-sft-tokenizer-") as directory:
            manifest = store.read_json(model["hfSnapshotRef"])
            require(manifest.get("tokenizerDigest") == model["tokenizerDigest"] and manifest.get("chatTemplateDigest") == model["chatTemplateDigest"],
                    "offline-tokenizer-drift", "sealed tokenizer manifest differs from model identity")
            destination = Path(directory) / "model"; destination.mkdir()
            allowed = {"config.json", "tokenizer.json", "tokenizer.model", "tokenizer_config.json", "special_tokens_map.json",
                       "added_tokens.json", "vocab.json", "merges.txt", "chat_template.jinja"}
            entries = [f for f in manifest["files"] if f["path"] in allowed]
            require(any(f["path"] in ("tokenizer.json", "tokenizer.model") for f in entries), "offline-tokenizer-unavailable", "sealed tokenizer files unavailable")
            for entry in entries:
                data = store.read_bytes(entry["contentRef"])
                require(digest_bytes(data) == entry["sha256"] and len(data) == entry["size"], "offline-tokenizer-drift", "tokenizer file drift")
                (destination / entry["path"]).write_bytes(data)
            tokenizer = AutoTokenizer.from_pretrained(Path(directory) / "model", trust_remote_code=False, local_files_only=True)
    require(len(payload["records"]) <= MAX_RECORDS, "offline-dataset-limit", "offline SFT v1 supports at most 1024 records")
    refs, total_bytes = [], 0
    for row in payload["records"]:
        require(isinstance(row, dict) and set(row) in ({"source", "segments"}, {"source", "messages"}, {"source", "messages", "tools"}),
                "invalid-offline-input", "each record needs a source and either role-token segments or chat messages")
        tokens, mask, roles = [], [], []
        if "segments" in row:
            require(isinstance(row["segments"], list) and row["segments"], "invalid-offline-input", "segments must be nonempty")
            for segment in row["segments"]:
                require(isinstance(segment, dict) and set(segment) == {"role", "tokens"} and segment["role"] in ROLES
                        and isinstance(segment["tokens"], list) and segment["tokens"], "invalid-offline-input", "segments require known role and token IDs")
                tokens.extend(segment["tokens"]); roles.extend([segment["role"]] * len(segment["tokens"]))
                mask.extend([int(segment["role"] == "assistant")] * len(segment["tokens"]))
        else:
            messages = row["messages"]
            require(isinstance(messages, list) and messages and all(isinstance(m, dict) and m.get("role") in ROLES for m in messages)
                    and any(m["role"] == "assistant" for m in messages), "invalid-offline-input", "chat record needs an assistant message")
            require("{% generation" in (tokenizer.chat_template or "") or "{%- generation" in (tokenizer.chat_template or ""),
                    "assistant-mask-unavailable", "HF template must declare native assistant generation spans")
            result = tokenizer.apply_chat_template(messages, tools=row.get("tools"), tokenize=True, add_generation_prompt=False,
                return_dict=True, return_assistant_tokens_mask=True)
            tokens = result["input_ids"]; mask = result.get("assistant_masks")
            require(isinstance(mask, list) and len(tokens) == len(mask) and any(mask),
                    "assistant-mask-unavailable", "tokenizer did not produce a native assistant mask")
            roles = ["assistant" if m else "user" for m in mask]
        if mask: mask[0] = 0
        body = {"schemaVersion": 1, "source": row["source"], "tokens": tokens, "lossMask": mask, "tokenRoles": roles}
        record = validate_record({**body, "id": digest_json(body)}, payload["maxSequenceTokens"])
        check_model_limits(record, limits, payload["maxSequenceTokens"])
        from .content import canonical
        total_bytes += len(canonical(record).encode())
        require(total_bytes <= MAX_DATA_BYTES, "offline-dataset-limit", "offline SFT v1 tokenized records exceed 4 MiB")
        refs.append(store.put_json(record))
    require(len({r["digest"] for r in refs}) == len(refs), "duplicate-offline-record", "SFT records must be unique")
    manifest = {"schemaVersion": 1, "kind": "offline-sft-dataset", "tokenizerDigest": model["tokenizerDigest"],
                "chatTemplateDigest": model["chatTemplateDigest"], "maskContract": "assistant-token-mask-v1", "records": refs}
    return {"datasetRef": store.put_json(manifest), "recordCount": len(refs), "maskContract": manifest["maskContract"]}


def read_dataset(store, request):
    config = request.get("offlineTraining")
    require(config and request["trainer"]["recipe"] == "offline-sft-v1", "offline-dataset-required", "offline SFT requires its sealed dataset")
    data = store.read_json(config["datasetRef"])
    require(set(data) == {"schemaVersion", "kind", "tokenizerDigest", "chatTemplateDigest", "maskContract", "records"}
            and data["schemaVersion"] == 1 and data["kind"] == "offline-sft-dataset"
            and data["maskContract"] == config["maskContract"] == "assistant-token-mask-v1"
            and all(data[k] == request["parentModel"][k] for k in ("tokenizerDigest", "chatTemplateDigest"))
            and isinstance(data["records"], list) and data["records"], "invalid-offline-dataset", "SFT dataset token semantics differ")
    require(len({r["digest"] for r in data["records"]}) == len(data["records"]), "duplicate-offline-record", "SFT records must be unique")
    require(len(data["records"]) <= MAX_RECORDS, "offline-dataset-limit", "offline SFT v1 supports at most 1024 records")
    total_bytes = 0
    limits = model_limits(store, request["parentModel"])
    for ref in data["records"]:
        total_bytes += len(store.read_bytes(ref))
        require(total_bytes <= MAX_DATA_BYTES, "offline-dataset-limit", "offline SFT v1 tokenized records exceed 4 MiB")
        record = validate_record(store.read_json(ref), config["maxSequenceTokens"])
        check_model_limits(record, limits, config["maxSequenceTokens"])
        require(any(record["source"] == {"taskId": t["id"], "family": t["family"], "taskDigest": t["taskRef"]["digest"]}
                    for t in request["trainDataset"]["tasks"]), "offline-provenance-mismatch", "SFT example is outside authorized train partition")
    return data


def window(records, seed, position, size):
    result, permutations = [], {}
    for index in range(position, position + size):
        epoch = index // len(records)
        if epoch not in permutations:
            permutations[epoch] = sorted(range(len(records)), key=lambda i: (digest_json({"seed": seed, "epoch": epoch, "index": i}), i))
        order = permutations[epoch]
        result.append(records[order[index % len(records)]])
    return result


def seal_batch(store, request, update):
    dataset = read_dataset(store, request)
    config, size = request["offlineTraining"], request["trainer"]["rolloutBatchSize"]
    position = update * size
    require(position + size <= len(dataset["records"]) * config["maxEpochs"], "offline-dataset-exhausted", "bounded offline epoch limit exhausted")
    refs = window(dataset["records"], config["shuffleSeed"], position, size)
    records = [store.read_json(ref) for ref in refs]
    body = {"schemaVersion": 3, "kind": "offline-sft-batch", "trainingRunId": request["trainingRunId"],
            "recipeDigest": request["recipeDigest"], "datasetSplitDigest": request["datasetSplitDigest"], "datasetRef": config["datasetRef"],
            "samplesRef": store.put_json(records), "recordRefs": refs,
            "cursorBefore": {"position": position}, "cursorAfter": {"position": position + size}, "state": "sealed"}
    return store.put_json({**body, "id": digest_json(body)})


def validate_batch(store, request, batch_ref, update):
    expected = seal_batch(store, request, update)
    require(batch_ref == expected, "offline-batch-drift", "sealed SFT replay differs from deterministic dataset window")
    return store.read_json(batch_ref)


def validate_cursor(store, request, checkpoint):
    cursor = store.read_json(checkpoint["dataCursorRef"])
    config = request["offlineTraining"]
    require(cursor.get("position") == checkpoint["committedUpdate"] * request["trainer"]["rolloutBatchSize"]
            and cursor.get("datasetDigest") == config["datasetRef"]["digest"], "offline-cursor-drift", "resumed SFT checkpoint must retain its exact data cursor")
    return cursor


def generate_rollout(args, rollout_id, data_source, evaluation=False):
    require(not evaluation, "evaluation-isolation", "offline SFT never consumes evaluation data")
    from slime.utils.types import Sample
    from slime.rollout.base_types import RolloutFnTrainOutput
    directory = Path(os.environ["GEAR_TRAINING_JOB"])
    request = json.loads((directory / "request.json").read_text())
    config = json.loads((directory / "config.json").read_text())
    store = ContentStore(config["storeRoot"])
    replay_path = directory / "offline-replay.json"
    if replay_path.exists():
        replay = json.loads(replay_path.read_text())
        require(replay.get("rolloutId") == rollout_id, "runtime-cursor-mismatch", "sealed offline replay belongs to another update")
        batch_ref = replay["batchRef"]
        batch = validate_batch(store, request, batch_ref, rollout_id)
    else:
        require(not request["trainer"].get("script"), "missing-offline-batch", "four-stage SFT requires its builder's sealed batch")
        batch_ref = seal_batch(store, request, rollout_id)
        batch = store.read_json(batch_ref)
    atomic_json(directory / "batch.json", {"rolloutId": rollout_id, "batchRef": batch_ref})
    result = []
    for i, record in enumerate(store.read_json(batch["samplesRef"])):
        first = record["lossMask"].index(1)
        sample = Sample(index=i, group_index=i, prompt="", tokens=record["tokens"], response_length=len(record["tokens"]) - first,
                        loss_mask=record["lossMask"][first:], reward=0, metadata={"offlineRecordId": record["id"]})
        sample.status = Sample.Status.COMPLETED
        sample.rollout_id = rollout_id * len(batch["recordRefs"]) + i
        result.append([sample])
    return RolloutFnTrainOutput(samples=result, metrics={"gear/offline_examples": len(result)})
