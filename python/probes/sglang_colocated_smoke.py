"""Bounded hardware diagnostic; never emits a validated training probe report.

Run under an external timeout. This checks the installed SGLang/native-token
and memory-saver APIs before spending time on the full pinned Slime workflow.
It does not substitute for Megatron training or weight-transfer validation.
"""
from __future__ import annotations

import argparse
import gc
import json
import math
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {"kind": "gear-sglang-hardware-diagnostic", "validated": False, "stages": []}

    def record(stage, **values):
        row = {"stage": stage, "elapsed_seconds": round(time.monotonic() - started, 3), **values}
        report["stages"].append(row)
        output.write_text(json.dumps(report, indent=2))
        print(json.dumps(row), flush=True)

    def memory():
        result = subprocess.run(["nvidia-smi", "--query-gpu=uuid,memory.used", "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, check=True, timeout=5)
        return result.stdout.strip()

    engine = None
    try:
        import torch
        from safetensors.torch import load_file
        from transformers import AutoTokenizer
        from sglang import Engine
        record("imports", torch=torch.__version__, cuda=torch.version.cuda, gpu=memory())
        tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
        inputs = tokenizer.apply_chat_template([{"role": "user", "content": "What is 2 + 2? Answer briefly."}],
                                               tokenize=True, add_generation_prompt=True, return_dict=False)
        assert isinstance(inputs, list) and inputs and all(type(token) is int for token in inputs)
        engine = Engine(model_path=args.model, dtype="bfloat16", tp_size=1,
                        mem_fraction_static=0.25, context_length=256, max_total_tokens=512,
                        chunked_prefill_size=256, max_running_requests=1,
                        disable_cuda_graph=True, disable_radix_cache=True,
                        enable_memory_saver=True, attention_backend="triton", sampling_backend="pytorch")
        record("engine-ready", gpu=memory())
        def generate(cycle):
            result = engine.generate(input_ids=inputs,
                                     sampling_params={"temperature": 0, "max_new_tokens": 8}, return_logprob=True)
            rows = result["meta_info"]["output_token_logprobs"]
            assert rows and all(isinstance(row[1], int) and math.isfinite(row[0]) for row in rows)
            assert result["meta_info"]["prompt_tokens"] == len(inputs)
            record("native-generation", cycle=cycle, output_token_ids=[row[1] for row in rows],
                   output_logprobs=[row[0] for row in rows], gpu=memory())
            return rows

        reference = generate(-1)
        weights = {}
        for shard in sorted(Path(args.model).glob("*.safetensors")):
            weights.update(load_file(str(shard), device="cpu"))
        assert weights, "no immutable HF tensors available for restore"

        for cycle in range(2):
            engine.release_memory_occupation()
            record("offloaded", cycle=cycle, gpu=memory())
            # Exercise CUDA while the inference allocation is offloaded.
            tensor = torch.randn((128, 128), device="cuda", dtype=torch.bfloat16, requires_grad=True)
            loss = (tensor @ tensor).float().square().mean()
            loss.backward(); torch.cuda.synchronize()
            assert bool(torch.isfinite(loss)) and bool(torch.isfinite(tensor.grad).all())
            del tensor, loss
            gc.collect(); torch.cuda.empty_cache()
            record("cuda-backward", cycle=cycle, gpu=memory())
            # Resuming allocation does not restore its contents. Match the
            # bridge order: onload weights -> tensor/IPC update -> onload KV.
            engine.resume_memory_occupation(tags=["weights"])
            bucket, size = [], 0
            for name, weight in weights.items():
                bucket.append((name, weight.to("cuda"))); size += weight.numel() * weight.element_size()
                if size >= 256 * 1024 ** 2:
                    engine.update_weights_from_tensor(bucket, flush_cache=False)
                    bucket, size = [], 0
            if bucket:
                engine.update_weights_from_tensor(bucket, flush_cache=False)
            del bucket
            gc.collect(); torch.cuda.empty_cache()
            engine.resume_memory_occupation(tags=["kv_cache"])
            record("onloaded", cycle=cycle, gpu=memory())
            restored = generate(cycle)
            assert [row[1] for row in restored] == [row[1] for row in reference], "restored weights changed greedy token identities"
            error = max(abs(a[0] - b[0]) for a, b in zip(restored, reference, strict=True))
            assert error <= 1e-4, f"restored weights changed logprobs: {error}"
            record("restored-weight-alignment", cycle=cycle, max_logprob_error=error)
        report["status"] = "passed"
    except BaseException as error:
        report["status"] = "failed"
        record("failure", error_type=type(error).__name__, error=str(error))
        raise
    finally:
        if engine is not None:
            engine.shutdown()
        record("finished", gpu=memory())


if __name__ == "__main__":
    main()
