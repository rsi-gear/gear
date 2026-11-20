"""CPU task-goal embeddings and scoped lesson lookup for the retail caller."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import platform
import shutil
import tempfile
from pathlib import Path

from gear.canonical import digest

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
FILES = {
    "config.json": "953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41",
    "model.safetensors": "53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db",
    "tokenizer.json": "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037",
    "tokenizer_config.json": "acb92769e8195aabd29b7b2137a9e6d6e25c476a4f15aa4355c233426c61576b",
    "special_tokens_map.json": "303df45a03609e4ead04bc3dc1536d0ab19b5358db685b6f3da123d05ec200e3",
    "vocab.txt": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    "sentence_bert_config.json": "fc1993fde0a95c24ec6c022539d41cf6e2f7c9721e5415d6fb6897472a9cd4b7",
    "1_Pooling/config.json": "4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23",
    "modules.json": "84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf",
}


def checked_vector(value, dimensions):
    if (
        not isinstance(value, list)
        or len(value) != dimensions
        or any(type(x) not in (int, float) or not math.isfinite(x) for x in value)
        or not math.isclose(math.fsum(x * x for x in value), 1, abs_tol=1e-6)
    ):
        raise ValueError("lesson lookup requires a finite normalized embedding")
    return value


class MiniLM:
    """Local safetensors, CPU float32, masked mean pooling; no model downloads."""

    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.model = self.tokenizer = None
        files = self.manifest()
        if files != FILES:
            raise ValueError("MiniLM files do not match the pinned official revision")
        config = json.loads((self.directory / "config.json").read_text())
        pooling = json.loads((self.directory / "1_Pooling/config.json").read_text())
        sentence = json.loads((self.directory / "sentence_bert_config.json").read_text())
        if (
            config.get("model_type") != "bert"
            or config.get("hidden_size") != 384
            or config.get("num_hidden_layers") != 6
            or sentence.get("max_seq_length") != 256
            or pooling.get("pooling_mode_mean_tokens") is not True
            or any(
                v is True
                for k, v in pooling.items()
                if k.startswith("pooling_mode_") and k != "pooling_mode_mean_tokens"
            )
        ):
            raise ValueError("expected the explicit MiniLM-L6 mean-pooling configuration")
        self.identity = {
            "kind": "selfdirection-minilm-cpu-v1",
            "model": MODEL,
            "revision": REVISION,
            "files": files,
            "packages": {
                name: importlib.metadata.version(name)
                for name in ("torch", "transformers", "tokenizers", "safetensors")
            },
            "device": "cpu",
            "dtype": "float32",
            "architecture": platform.machine(),
            "pooling": "normalized-masked-mean",
            "dimensions": 384,
            "max_tokens": 256,
            "truncation": False,
        }

    def manifest(self):
        return {
            name: hashlib.sha256((self.directory / name).read_bytes()).hexdigest() for name in FILES
        }

    def encode(self, text):
        import torch
        from transformers import AutoModel, AutoTokenizer

        if not isinstance(text, str) or not text.strip():
            raise ValueError("lesson goal must be nonempty")
        if self.manifest() != self.identity["files"]:
            raise ValueError("frozen MiniLM files changed")
        if self.model is None:
            # Loading a directory containing extra, unhashed tokenizer files could
            # change inference. Only the declared file set reaches Transformers.
            with tempfile.TemporaryDirectory(prefix="gear-selfdirection-model-") as tmp:
                for name in FILES:
                    target = Path(tmp) / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(self.directory / name, target)
                    if (
                        hashlib.sha256(target.read_bytes()).hexdigest()
                        != self.identity["files"][name]
                    ):
                        raise ValueError("MiniLM bytes changed while loading")
                self.tokenizer = AutoTokenizer.from_pretrained(
                    tmp, local_files_only=True, trust_remote_code=False
                )
                self.model = (
                    AutoModel.from_pretrained(
                        tmp,
                        local_files_only=True,
                        trust_remote_code=False,
                        use_safetensors=True,
                        dtype=torch.float32,
                        attn_implementation="eager",
                    )
                    .to("cpu")
                    .eval()
                    .requires_grad_(False)
                )
        inputs = self.tokenizer(text, return_tensors="pt", truncation=False)
        tokens = inputs["input_ids"].shape[1]
        if tokens > self.identity["max_tokens"]:
            raise ValueError(
                "task goal exceeds MiniLM's explicit token limit; no silent truncation"
            )
        with torch.inference_mode():
            hidden = self.model(**inputs).last_hidden_state[0]
            mask = inputs["attention_mask"][0].unsqueeze(-1)
            mean = ((hidden * mask).sum(0) / mask.sum()).tolist()
        length = math.sqrt(math.fsum(x * x for x in mean))
        vector = checked_vector([x / length for x in mean], self.identity["dimensions"])
        return {"vector": vector, "tokens": tokens}


def lookup(goal, vector, lessons, *, scope, threshold, embedding_identity):
    dimensions = embedding_identity["dimensions"]
    checked_vector(vector, dimensions)
    candidates = []
    for lesson in lessons:
        if lesson["scope"] != scope or lesson["embedding_identity"] != digest(embedding_identity):
            continue
        other = checked_vector(lesson["vector"], dimensions)
        score = max(-1.0, min(1.0, math.fsum(a * b for a, b in zip(vector, other))))
        # This makes the documented same-goal-only setting explicit rather than
        # depending on floating point rounding or two coincident embeddings.
        same_goal = goal == lesson["goal"]
        if same_goal:
            if not math.isclose(score, 1.0, abs_tol=1e-6):
                raise ValueError("the same task goal has inconsistent lesson embeddings")
            score = 1.0
        candidates.append(
            {"lesson_id": lesson["lesson_id"], "score": score, "same_goal": same_goal}
        )
    candidates.sort(key=lambda row: (-row["score"], row["lesson_id"]))
    eligible = [
        row
        for row in candidates
        if row["score"] >= threshold and (threshold < 1 or row["same_goal"])
    ]
    return {
        "threshold": threshold,
        "candidates": candidates,
        "selected": eligible[0]["lesson_id"] if eligible else None,
    }
