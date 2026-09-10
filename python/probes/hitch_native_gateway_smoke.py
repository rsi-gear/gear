"""Real native gateway/Harbor diagnostic; no training or runtime certification.

Launch under an external timeout. The controller reads private/binding.json over
SSH, runs the fixed Hitch harness, and writes canonical evidence to finish.json.
Only the generation gateway is tunneled; SGLang management stays on loopback.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

from gear_training.content import ContentStore, atomic_json, digest_bytes, digest_file, digest_json
from gear_training.gateway import ExactGateway, NativeSGLang, slime_protocol
from gear_training.ledger import Ledger
from gear_training.recipes.agent_grpo import sampling_params


async def run(options):
    import aiohttp
    from aiohttp import web
    from transformers import AutoTokenizer
    from sglang.srt.server_args import ServerArgs

    root = options.output
    root.mkdir(parents=True, exist_ok=True)
    private = root / "private"
    private.mkdir(mode=0o700, exist_ok=True)
    store = ContentStore(root / "content")
    task_input = json.loads(Path(options.task_input).read_text())
    assert task_input["kind"] == "native-diagnostic-task-input" and isinstance(task_input["instruction"], str)
    task_ref = store.put_json(task_input)
    model = Path(options.model)
    files = {str(p.relative_to(model)): digest_file(p) for p in sorted(model.iterdir()) if p.is_file()}
    model_ref = store.put_json({"kind": "diagnostic-model-files", "files": files})
    assert any(name.endswith(".safetensors") for name in files)
    tokenizer = AutoTokenizer.from_pretrained(model, local_files_only=True, trust_remote_code=False)
    render, parse = slime_protocol(tokenizer, "qwen25", None)
    tools = [{"type": "function", "function": {"name": "bash", "description": "Run a command in the task container.",
             "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"], "additionalProperties": False}}}]
    body = {"messages": [{"role": "user", "content": "Use the bash tool."}], "tools": tools}
    assert len(render(body)) < 2048
    from slime.agent.parsing import parse_model_output
    from slime.agent.adapters.openai import _tools_to_chat_tools
    parse_model_output("done", tools_schema=_tools_to_chat_tools(tools), tool_parser_name="qwen25", reasoning_parser_name=None)
    assert "weight_version" in ServerArgs.__dataclass_fields__
    atomic_json(root / "prepared.json", {"modelRef": model_ref, "toolParser": "qwen25", "sampling": "temperature=1, top_p=1, top_k=-1"})
    if options.prepare_only:
        return

    started = time.monotonic()
    summary = {"kind": "hitch-native-gateway-diagnostic", "validated": False, "training_executed": False,
               "modelRef": model_ref, "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    engine = runner = ledger = None
    log = (root / "engine.log").open("w")
    try:
        runtime = "native-diagnostic-" + secrets.token_hex(12)
        policy = runtime + "/initial"
        sampling = sampling_params({"sampling": {"temperature": 1, "topP": 1, "topK": -1, "repetitionPenalty": 1, "maxNewTokens": 256}})
        protocol_ref = store.put_json({"toolParser": "qwen25", "sampling": sampling, "maxContextTokens": 2048})
        lease = {"schemaVersion": 1, "trainingRunId": runtime, "batchId": "native-batch-0", "policyVersion": policy,
                 "parentModelVersionId": model_ref["digest"], "synchronizedWeightsRef": model_ref, "runtimeInstanceId": runtime,
                 "samplingDigest": digest_json(sampling), "fencingToken": secrets.token_hex(16),
                 "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=options.seconds)).isoformat(), "state": "serving"}
        version = model_ref["digest"]
        command = [sys.executable, "-m", "sglang.launch_server", "--model-path", str(model), "--host", "127.0.0.1",
                   "--port", str(options.engine_port), "--weight-version", version, "--dtype", "bfloat16", "--tp-size", "1",
                   "--mem-fraction-static", "0.25", "--context-length", "2048", "--max-total-tokens", "4096",
                   "--chunked-prefill-size", "512", "--max-running-requests", "1", "--disable-cuda-graph",
                   "--disable-radix-cache", "--attention-backend", "triton", "--sampling-backend", "pytorch", "--random-seed", "1234"]
        atomic_json(root / "engine-command.json", command)
        engine = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        engine_url = "http://127.0.0.1:" + str(options.engine_port)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as session:
            until = time.monotonic() + 90
            while time.monotonic() < until:
                assert engine.poll() is None, "native engine exited before ready"
                try:
                    async with session.get(engine_url + "/get_weight_version") as response:
                        if response.status == 200:
                            assert (await response.json())["weight_version"] == version
                            break
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    pass
                await asyncio.sleep(1)
            else:
                raise TimeoutError("native engine did not become ready")
        ledger = Ledger(root / "ledger.sqlite")
        ledger.open_lease(lease, [{"replicaId": "engine-0", "weightsDigest": model_ref["digest"], "runtimeInstanceId": runtime, "policyVersion": policy}])
        token_digest = files["tokenizer.json"]
        template_digest = digest_json(tokenizer.chat_template)
        context = {"id": "native-episode-0", "trainingRunId": runtime, "batchId": lease["batchId"], "bindingId": "binding_" + secrets.token_hex(16),
                   "groupId": "native-group-0", "slot": 0, "runId": None, "taskId": "one", "logicalAttempt": 1,
                   "taskRef": task_ref,
                   "policyVersion": policy, "wireModel": policy, "runtimeInstanceId": runtime,
                   "tokenizerDigest": token_digest, "chatTemplateDigest": template_digest, "sampling": sampling,
                   "maxRolloutTokens": 2048, "maxContextTokens": 2048, "maxEpisodeSteps": 4, "generationContractDigest": protocol_ref["digest"]}
        credential = secrets.token_hex(32)
        ledger.register_episode(context, digest_bytes(credential.encode()))
        gateway = ExactGateway(store, ledger, NativeSGLang(engine_url, version, timeout=45), runtime, token_digest, template_digest, render, parse)
        runner = web.AppRunner(gateway.application())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", options.gateway_port).start()
        binding = {"kind": "training-external", "bindingId": context["bindingId"], "trainingRunId": runtime, "policyLeaseRef": store.put_json(lease),
                   "expectedPolicyVersion": policy, "fencingToken": lease["fencingToken"], "expiresAt": lease["expiresAt"],
                   "endpointRef": "hitch-training:" + context["bindingId"], "credentialRef": "hitch-training:" + context["bindingId"],
                   "generationContractDigest": protocol_ref["digest"], "requiredCapture": "exact-policy-tokens-v1", "api": "chat-completions",
                   "maxOutputTokens": 256, "maxEpisodeSteps": 4}
        atomic_json(private / "binding.json", {"schema_version": "1", "binding": binding, "credential": credential})
        os.chmod(private / "binding.json", 0o600)
        atomic_json(root / "ready.json", {"gatewayPort": options.gateway_port, "policyVersion": policy, "weightVersion": version})
        print(json.dumps({"stage": "gateway-ready", "elapsed_seconds": time.monotonic() - started}), flush=True)
        while not (root / "finish.json").exists():
            assert engine.poll() is None, "native engine exited during Harbor execution"
            if time.monotonic() - started >= options.seconds:
                raise TimeoutError("controller did not return canonical evidence within the diagnostic budget")
            await asyncio.sleep(0.2)
        finish = json.loads((root / "finish.json").read_text())
        assert finish["status"] == "passed", "Hitch native canary failed"
        ledger.finish_episode(context["id"])
        actual_context = ledger.context(context["id"])
        receipts = [store.read_json(ref) for ref in ledger.receipts(context["id"])]
        assert finish["run_id"] == actual_context["runId"]
        assert finish["receipt_ids"] == [r["id"] for r in receipts], "canonical harness receipts differ from the native ledger"
        assert len(receipts) >= 2 and all(r["runId"] == finish["run_id"] and r["policyVersion"] == policy for r in receipts)
        assert len({r["requestId"] for r in receipts}) == len(receipts)
        tool_count = 0
        for i, receipt in enumerate(receipts):
            raw = store.read_json(receipt["rawResponseRef"])
            tool_count += len(raw["wire"]["choices"][0]["message"].get("tool_calls") or [])
            if i:
                previous = receipts[i - 1]
                prefix = store.read_json(previous["inputTokenIdsRef"]) + store.read_json(previous["outputTokenIdsRef"])
                inputs = store.read_json(receipt["inputTokenIdsRef"])
                assert inputs[:len(prefix)] == prefix, "next native prompt does not preserve the previous exact tokens"
        assert tool_count >= 2 and receipts[-1]["finishReason"] == "stop"
        atomic_json(root / "receipts.json", receipts)
        ledger.drain(lease["batchId"])
        ledger.close_lease(lease["batchId"])
        summary.update(status="passed", run_id=finish["run_id"], model_calls=len(receipts), tool_calls=tool_count,
                       rollout_tokens=ledger.usage()["rolloutTokens"], exact_prefix_continuity=True,
                       task_reward=finish["task_reward"], task_succeeded=finish["task_succeeded"])
    except BaseException as error:
        summary.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        if runner is not None:
            await runner.cleanup()
        if ledger is not None:
            ledger.close()
        if engine is not None and engine.poll() is None:
            os.killpg(engine.pid, signal.SIGTERM)
            try:
                await asyncio.to_thread(engine.wait, timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(engine.pid, signal.SIGKILL)
                await asyncio.to_thread(engine.wait, timeout=5)
        log.close()
        summary["elapsed_seconds"] = round(time.monotonic() - started, 3)
        atomic_json(root / "summary.json", summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--task-input", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine-port", type=int, default=31000)
    parser.add_argument("--gateway-port", type=int, default=31001)
    parser.add_argument("--seconds", type=int, default=240)
    parser.add_argument("--prepare-only", action="store_true")
    options = parser.parse_args()
    assert 60 <= options.seconds <= 600
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    asyncio.run(run(options))
