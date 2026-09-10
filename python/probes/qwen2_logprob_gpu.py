"""Bounded HF GPU teacher forcing of saved tokens, with CPU rounding controls.

No generation, optimizer, checkpoint, or compatibility certification. Invoke
only within an owned diagnostic directory with a separate instance stop guard.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import time

from qwen2_logprob_reference import ROUNDING_MODES, boundary_layer, boundary_norm, validate_samples


def score_hidden(hidden, weight, selected):
    import torch
    ids = torch.tensor(selected, device=hidden.device)
    denominator = torch.full((len(selected),), -torch.inf, dtype=torch.float64, device=hidden.device)
    chosen = torch.full_like(denominator, float('nan'))
    for start in range(0, weight.shape[0], 4096):
        end = min(start + 4096, weight.shape[0])
        logits = torch.nn.functional.linear(hidden, weight[start:end]).double()
        denominator = torch.logaddexp(denominator, torch.logsumexp(logits, -1))
        rows = ((ids >= start) & (ids < end)).nonzero().flatten()
        chosen[rows] = logits[rows, ids[rows] - start]
    assert torch.isfinite(chosen).all() and torch.isfinite(denominator).all()
    return (chosen - denominator).tolist()


def compare_model(model, samples):
    import torch
    device, dtype = model.get_input_embeddings().weight.device, model.get_input_embeddings().weight.dtype
    first_ids = sorted({row['tokens'][-row['response_length']] for row in samples})
    outputs = []
    for mode in ROUNDING_MODES:
        started = time.monotonic()
        rows = []
        for row in samples:
            tokens = torch.tensor([row['tokens']], device=device)
            length, count = tokens.shape[1], row['response_length']
            value = model.model.embed_tokens(tokens)
            positions = torch.arange(length, device=device)[None, :]
            rope = model.model.rotary_emb(value, positions)
            mask = torch.triu(torch.full((1, 1, length, length), torch.finfo(dtype).min,
                                        dtype=dtype, device=device), diagonal=1)
            exact = None
            for layer in model.model.layers:
                if mode == 'hf':
                    value = layer(value, attention_mask=mask, position_ids=positions,
                                  position_embeddings=rope, use_cache=False)
                    if isinstance(value, tuple):
                        value = value[0]
                else:
                    value, exact = boundary_layer(layer, value, exact, mask, positions, rope, mode)
            normalized = model.model.norm(value) if mode == 'hf' else boundary_norm(
                exact if exact is not None else value, model.model.norm, dtype, mode.endswith('fp32-norm'))
            selected = row['tokens'][-count:]
            probs = score_hidden(normalized[0, length-count-1:-1], model.lm_head.weight, selected)
            # Same requested token IDs at the identical prefix position in each
            # sample permit a direct comparison; unlike comparing two different
            # first response token scores, this measures an actual shared input.
            prefix_hidden = normalized[0, length-count-1].expand(len(first_ids), -1)
            prefix = score_hidden(prefix_hidden, model.lm_head.weight, first_ids)
            result = dict(index=row['index'], responseTokens=selected, referenceLogprobs=probs,
                          nativeLogprobs=row['rollout_log_probs'], prefixTokenIds=first_ids,
                          prefixLogprobs=prefix)
            if mode == 'hf':
                logits = model(input_ids=tokens, use_cache=False).logits
                scores = logits[0, length-count-1:-1].double().log_softmax(-1)
                full = scores.gather(-1, tokens[0, -count:, None]).flatten().tolist()
                result['stockHfLogprobs'] = full
                result['stockVsSelectedProjectionMaxDifference'] = max(abs(a-b) for a,b in zip(full, probs, strict=True))
                result['stockLogitsDtype'] = str(logits.dtype)
                del logits, scores
            rows.append(result)
        outputs.append(dict(roundingMode=mode, samples=rows, elapsedSeconds=time.monotonic()-started))
        print(json.dumps({'stage': 'mode-completed', 'mode': mode}), flush=True)
    return outputs


def self_test(output):
    import torch
    from transformers import Qwen2Config, Qwen2ForCausalLM
    from qwen2_logprob_reference import reference
    import tempfile
    torch.manual_seed(20260909)
    config = Qwen2Config(vocab_size=67, hidden_size=24, intermediate_size=40, num_hidden_layers=3,
                         num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=64,
                         rope_parameters={'rope_type':'default', 'rope_theta':1000000.0})
    config._attn_implementation = 'eager'
    model = Qwen2ForCausalLM(config).to(dtype=torch.bfloat16).eval()
    samples = [dict(index=0, tokens=[1,3,7,5,2], response_length=2, rollout_log_probs=[0.0]*2),
               dict(index=1, tokens=[1,3,7,6,8,2], response_length=3, rollout_log_probs=[0.0]*3)]
    checks = []
    with torch.inference_mode(), tempfile.TemporaryDirectory() as directory:
        for layer in model.model.layers:
            for norm in (layer.input_layernorm, layer.post_attention_layernorm):
                norm.weight.copy_(torch.linspace(0.3, 1.8, 24).to(torch.bfloat16))
        model.save_pretrained(directory, safe_serialization=True)
        actual = compare_model(model, samples)
        for record in actual:
            expected = reference(directory, samples, 'bfloat16', chunk_size=17, rounding_mode=record['roundingMode'])
            difference = max(abs(a-b) for row, ref in zip(record['samples'],expected,strict=True)
                             for a,b in zip(row['referenceLogprobs'],ref,strict=True))
            assert difference < 1e-5
            if record['roundingMode'] == 'hf':
                assert all(row['stockVsSelectedProjectionMaxDifference'] < 1e-5 for row in record['samples'])
            checks.append(dict(mode=record['roundingMode'], maxDifference=difference, tolerance=1e-5))
    output.write_text(json.dumps(dict(passed=True, validated=False, device='cpu', checks=checks), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path)
    parser.add_argument('--rollout', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    if args.self_test:
        self_test(args.output / 'cpu-check.json')
        return
    assert args.model and args.rollout and torch.cuda.is_available() and torch.cuda.device_count() == 1
    from transformers import Qwen2Config, Qwen2ForCausalLM
    config = Qwen2Config.from_pretrained(args.model, local_files_only=True)
    assert (config.num_hidden_layers, config.hidden_size, config.intermediate_size, config.vocab_size) == (28,1536,8960,151936)
    assert config.tie_word_embeddings and not config.use_sliding_window
    samples = json.loads(args.rollout.read_text())
    validate_samples(samples, config.vocab_size)
    assert len(samples) == 2 and samples[0]['tokens'][:-samples[0]['response_length']] == samples[1]['tokens'][:-samples[1]['response_length']]
    source_dir = args.output / 'installed-sources'
    source_dir.mkdir()
    sources = {}
    sglang = importlib.util.find_spec('sglang')
    assert sglang and sglang.submodule_search_locations
    package = Path(next(iter(sglang.submodule_search_locations)))
    for relative in ('srt/layers/layernorm.py', 'srt/models/qwen2.py', 'srt/layers/logits_processor.py'):
        file = package / relative
        content = file.read_bytes()
        assert 0 < len(content) < 1048576
        (source_dir / file.name).write_bytes(content)
        sources[relative] = dict(path=str(file), sha256=hashlib.sha256(content).hexdigest())
    started = time.monotonic()
    model = Qwen2ForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16,
                                            local_files_only=True, attn_implementation='eager').to('cuda').eval()
    torch.cuda.reset_peak_memory_stats()
    with torch.inference_mode():
        modes = compare_model(model, samples)
    torch.cuda.synchronize()
    result = dict(kind='qwen2-gpu-rounding-reference', validated=False, modes=modes, device='cuda',
                  elapsedSeconds=time.monotonic()-started, peakAllocatedBytes=torch.cuda.max_memory_allocated(),
                  peakReservedBytes=torch.cuda.max_memory_reserved(), sources=sources,
                  versions={name:importlib.metadata.version(name) for name in ['torch','transformers','sglang']},
                  bf16ReducedPrecisionReduction=torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction,
                  inputSha256=hashlib.sha256(args.rollout.read_bytes()).hexdigest(),
                  generation=False, optimizer=False, checkpoint=False,
                  scope='Actual GPU HF teacher forcing; source-informed arithmetic ablations; not a Megatron/SGLang kernel replacement or runtime certification.')
    (args.output / 'result.json').write_text(json.dumps(result,indent=2))
    del model
    torch.cuda.empty_cache()
    print(json.dumps({'stage':'completed','elapsedSeconds':result['elapsedSeconds'],
                      'peakAllocatedBytes':result['peakAllocatedBytes']}),flush=True)


if __name__ == '__main__':
    main()
