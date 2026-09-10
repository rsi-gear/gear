"""Bounded CPU teacher-forcing reference for saved Qwen2 native token facts.

The default uses installed Transformers decoder layers one at a time and chunks
the vocabulary projection. Optional rounding ablations replace only the residual
and normalization boundaries. This is diagnosis, not GPU/runtime certification.
"""
import argparse
import gc
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import resource
import sys
import tempfile
import time


def peak_rss_mib():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value / (1024 ** 2 if sys.platform == "darwin" else 1024)


def validate_samples(samples, vocab_size):
    assert isinstance(samples, list) and 1 <= len(samples) <= 4
    for row in samples:
        tokens, count, log_probs = row["tokens"], row["response_length"], row["rollout_log_probs"]
        assert isinstance(tokens, list) and len(tokens) <= 256
        assert all(type(token) is int and 0 <= token < vocab_size for token in tokens)
        assert type(count) is int and 0 < count < len(tokens)
        assert len(log_probs) == count and all(type(value) in (float, int) and math.isfinite(value) for value in log_probs)


class Weights:
    def __init__(self, directory):
        from safetensors import safe_open
        self.files = {}
        for file in sorted(Path(directory).glob("*.safetensors")):
            with safe_open(file, framework="pt", device="cpu") as reader:
                for key in reader.keys():
                    assert key not in self.files, f"duplicate tensor: {key}"
                    self.files[key] = file
        assert self.files

    def tensor(self, name, dtype, rows=None):
        from safetensors import safe_open
        with safe_open(self.files[name], framework="pt", device="cpu") as reader:
            source = reader.get_tensor(name) if rows is None else reader.get_slice(name)[rows]
            # Detach from the mmap even when dtype already matches. Only the
            # selected rows or this layer are retained after closing the file.
            return source.to(dtype=dtype, copy=True)

    def embedding(self, name, token_rows, dtype):
        import torch
        from safetensors import safe_open
        with safe_open(self.files[name], framework="pt", device="cpu") as reader:
            weight = reader.get_tensor(name)
            return [torch.nn.functional.embedding(tokens, weight).to(dtype=dtype, copy=True) for tokens in token_rows]

    def layer(self, index, dtype):
        prefix = f"model.layers.{index}."
        return {name.removeprefix(prefix): self.tensor(name, dtype) for name in self.files if name.startswith(prefix)}


ROUNDING_MODES = ("hf", "fp32-norm", "fused-residual", "fused-residual-fp32-norm")


def boundary_norm(value, norm, output_dtype, fp32_weight):
    """CPU rounding ablation; not a replacement for a GPU normalization kernel."""
    import torch
    value = value.float()
    normalized = value * torch.rsqrt(value.pow(2).mean(-1, keepdim=True) + norm.variance_epsilon)
    if fp32_weight:
        return (normalized * norm.weight.float()).to(output_dtype)
    return normalized.to(output_dtype) * norm.weight


def boundary_layer(layer, value, exact_sum, mask, positions, rope, mode):
    fused = mode.startswith("fused-residual")
    fp32_weight = mode.endswith("fp32-norm")
    normalized = boundary_norm(exact_sum if exact_sum is not None else value,
                               layer.input_layernorm, value.dtype, fp32_weight)
    attention, _ = layer.self_attn(normalized, attention_mask=mask, position_ids=positions,
                                   position_embeddings=rope, use_cache=False)
    pre_mlp = attention.float() + value.float()
    residual = pre_mlp.to(value.dtype)
    normalized = boundary_norm(pre_mlp if fused else residual,
                               layer.post_attention_layernorm, value.dtype, fp32_weight)
    # As in SGLang's native residual/RMSNorm boundary, the carried residual
    # stays in the activation dtype. Only the input to the next norm can use
    # the unrounded sum; this is not an FP32 residual stream across layers.
    exact_output = layer.mlp(normalized).float() + residual.float()
    return exact_output.to(value.dtype), exact_output if fused else None


def reference(directory, samples, dtype_name="float32", chunk_size=4096, rss_limit=1536, progress=None,
              rounding_mode="hf"):
    import torch
    from transformers import Qwen2Config
    from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer, Qwen2RMSNorm, Qwen2RotaryEmbedding

    config = Qwen2Config.from_pretrained(directory, local_files_only=True)
    assert config.model_type == "qwen2" and not config.use_sliding_window
    assert config.hidden_size <= 1536 and config.intermediate_size <= 8960 and config.num_hidden_layers <= 28
    assert config.vocab_size <= 151936 and config.hidden_act == "silu"
    config._attn_implementation = "eager"
    config.use_cache = False
    validate_samples(samples, config.vocab_size)
    assert dtype_name in ("float32", "bfloat16") and 1 <= chunk_size <= 8192
    assert rounding_mode in ROUNDING_MODES
    dtype = getattr(torch, dtype_name)
    weights = Weights(directory)
    tokens = [torch.tensor([row["tokens"]], dtype=torch.long, device="cpu") for row in samples]
    selected = []
    offsets = []
    for row in samples:
        offsets.append(len(selected))
        selected.extend(row["tokens"][-row["response_length"]:])

    def check(stage):
        observed = peak_rss_mib()
        if progress:
            progress(stage, observed)
        assert observed <= rss_limit, f"CPU reference exceeded its RSS limit: {observed:.1f} MiB"

    with torch.inference_mode():
        hidden = weights.embedding("model.embed_tokens.weight", tokens, dtype)
        exact_sums = [None] * len(hidden)
        position_ids = [torch.arange(row.shape[1], device="cpu")[None, :] for row in tokens]
        rotary = Qwen2RotaryEmbedding(config, device="cpu")
        embeddings = [rotary(value, positions) for value, positions in zip(hidden, position_ids, strict=True)]
        masks = [torch.triu(torch.full((1, 1, row.shape[1], row.shape[1]), torch.finfo(dtype).min, dtype=dtype), diagonal=1) for row in tokens]
        check("embeddings")
        for index in range(config.num_hidden_layers):
            with torch.device("meta"):
                layer = Qwen2DecoderLayer(config, index)
            state = weights.layer(index, dtype)
            layer.load_state_dict(state, strict=True, assign=True)
            layer.eval()
            if rounding_mode == "hf":
                hidden = [layer(value, attention_mask=mask, position_ids=positions, position_embeddings=rope, use_cache=False)
                          for value, mask, positions, rope in zip(hidden, masks, position_ids, embeddings, strict=True)]
            else:
                stepped = [boundary_layer(layer, value, exact, mask, positions, rope, rounding_mode)
                           for value, exact, mask, positions, rope in
                           zip(hidden, exact_sums, masks, position_ids, embeddings, strict=True)]
                hidden, exact_sums = map(list, zip(*stepped, strict=True))
                del stepped
            assert all(torch.isfinite(value).all().item() for value in hidden)
            del layer, state
            gc.collect()
            check(f"layer-{index}")
        norm = Qwen2RMSNorm(config.hidden_size, eps=config.rms_norm_eps).to(dtype=dtype)
        norm.load_state_dict({"weight": weights.tensor("model.norm.weight", dtype)}, assign=True)
        # Token at index t is scored by hidden state t-1; the last hidden state
        # would predict a token outside the saved response and is excluded.
        normalized = [norm(value) if rounding_mode == "hf" else
                      boundary_norm(exact if exact is not None else value, norm, dtype,
                                    rounding_mode.endswith("fp32-norm"))
                      for value, exact in zip(hidden, exact_sums, strict=True)]
        response_hidden = torch.cat([value[0, len(row["tokens"]) - row["response_length"] - 1:-1]
                                     for value, row in zip(normalized, samples, strict=True)], dim=0)
        assert response_hidden.shape[0] == len(selected)
        projection = "model.embed_tokens.weight" if config.tie_word_embeddings else "lm_head.weight"
        denominator = torch.full((len(selected),), -torch.inf, dtype=torch.float64)
        chosen = torch.full_like(denominator, float("nan"))
        selected_ids = torch.tensor(selected)
        for start in range(0, config.vocab_size, chunk_size):
            end = min(start + chunk_size, config.vocab_size)
            matrix = weights.tensor(projection, dtype, slice(start, end))
            logits = torch.nn.functional.linear(response_hidden, matrix).to(torch.float64)
            denominator = torch.logaddexp(denominator, torch.logsumexp(logits, dim=-1))
            included = (selected_ids >= start) & (selected_ids < end)
            rows = included.nonzero().flatten()
            chosen[rows] = logits[rows, selected_ids[rows] - start]
            del matrix, logits
        assert torch.isfinite(chosen).all() and torch.isfinite(denominator).all()
        output = (chosen - denominator).tolist()
        check("vocabulary-projection")
    return [output[offset:offset + row["response_length"]] for offset, row in zip(offsets, samples, strict=True)]


def self_test(output):
    import torch
    from transformers import Qwen2Config, Qwen2ForCausalLM
    torch.manual_seed(20260909)
    checks = []
    samples = [{"tokens": [1, 3, 7, 5, 2], "response_length": 2, "rollout_log_probs": [0.0] * 2},
               {"tokens": [1, 6, 9, 4, 8, 2], "response_length": 4, "rollout_log_probs": [0.0] * 4}]
    for tied in (True, False):
        for dtype_name in ("float32", "bfloat16"):
            config = Qwen2Config(vocab_size=67, hidden_size=24, intermediate_size=40, num_hidden_layers=2,
                                 num_attention_heads=4, num_key_value_heads=2, tie_word_embeddings=tied,
                                 max_position_embeddings=64, rope_parameters={"rope_type": "default", "rope_theta": 1000000.0})
            config._attn_implementation = "eager"
            model = Qwen2ForCausalLM(config).to(dtype=getattr(torch, dtype_name)).eval()
            expected = []
            with torch.inference_mode():
                for row in samples:
                    tokens = torch.tensor([row["tokens"]])
                    logits = model(input_ids=tokens, use_cache=False).logits.float()
                    selected_logits = logits[0, len(row["tokens"]) - row["response_length"] - 1:-1]
                    selected = tokens[0, -row["response_length"]:]
                    expected.append(selected_logits.log_softmax(-1).gather(-1, selected[:, None])[:, 0].tolist())
            with tempfile.TemporaryDirectory(prefix="qwen-reference-check-") as directory:
                model.save_pretrained(directory, safe_serialization=True)
                actual = reference(directory, samples, dtype_name, chunk_size=17)
            delta = max(abs(a - b) for a_row, b_row in zip(actual, expected, strict=True) for a, b in zip(a_row, b_row, strict=True))
            tolerance = 1e-5
            assert delta <= tolerance, f"streamed reference disagrees with the complete HF model: {delta}"
            checks.append({"tiedEmbeddings": tied, "dtype": dtype_name, "maximumAbsoluteLogprobDifference": delta, "tolerance": tolerance})
            del model
            gc.collect()
    result = {"kind": "qwen2-streamed-reference-cpu-check", "passed": True, "validated": False,
              "checks": checks, "peakRssMiB": peak_rss_mib(), "scope": "Tiny actual HF models; CPU only; not 1.5B/GPU compatibility evidence."}
    output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--rollout", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dtype", choices=["float32", "bfloat16"], default="float32")
    parser.add_argument("--rounding-mode", choices=ROUNDING_MODES, default="hf")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--max-rss-mib", type=float, default=1536)
    options = parser.parse_args()
    assert 1 <= options.threads <= 4 and 512 <= options.max_rss_mib <= 1536
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import torch
    torch.set_num_threads(options.threads)
    torch.set_num_interop_threads(1)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    assert not options.output.exists(), "preserve the previous numerical reference"
    if options.self_test:
        self_test(options.output)
        return
    assert options.model and options.rollout
    samples = json.loads(options.rollout.read_text())
    begin = time.monotonic()
    def progress(stage, rss):
        print(json.dumps({"stage": stage, "elapsedSeconds": round(time.monotonic() - begin, 3), "peakRssMiB": rss}), flush=True)
    expected = reference(options.model, samples, options.dtype, rss_limit=options.max_rss_mib, progress=progress,
                         rounding_mode=options.rounding_mode)
    rows = []
    for sample, reference_probs in zip(samples, expected, strict=True):
        differences = [a - b for a, b in zip(reference_probs, sample["rollout_log_probs"], strict=True)]
        rows.append({"index": sample["index"], "responseTokens": sample["tokens"][-sample["response_length"]:],
                     "referenceLogprobs": reference_probs, "nativeLogprobs": sample["rollout_log_probs"],
                     "referenceMinusNative": differences, "meanAbsoluteDifference": sum(map(abs, differences)) / len(differences),
                     "maximumAbsoluteDifference": max(map(abs, differences))})
    def digest(file):
        with file.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()
    result = {"kind": "qwen2-cpu-native-logprob-reference", "validated": False, "device": "cpu", "dtype": options.dtype,
              "attention": "transformers-eager", "normalizerDtype": "float64", "samples": rows,
              "roundingMode": options.rounding_mode,
              "sampleMeanAbsoluteDifference": sum(row["meanAbsoluteDifference"] for row in rows) / len(rows),
              "peakRssMiB": peak_rss_mib(), "elapsedSeconds": time.monotonic() - begin,
              "versions": {name: importlib.metadata.version(name) for name in ["torch", "transformers", "safetensors"]},
              "inputSha256": digest(options.rollout), "modelFiles": {file.name: digest(file) for file in sorted(options.model.iterdir())
                           if file.is_file() and (file.suffix == ".safetensors" or file.name == "config.json")},
              "scope": "Offline teacher forcing of saved native tokens; no actor logprobs, GPU execution, task reward, or compatibility certification."}
    options.output.write_text(json.dumps(result, indent=2))
    print(json.dumps({"stage": "reference-finished", "sampleMeanAbsoluteDifference": result["sampleMeanAbsoluteDifference"], "peakRssMiB": result["peakRssMiB"]}), flush=True)


if __name__ == "__main__":
    main()
