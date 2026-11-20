"""Real Hitch runner/proxy -> Gear gateway/capture; model and verifier are doubles.

Set GEAR_DIAGEVO_HITCH_PATH to the built, patched Hitch checkout to run the
cross-repository probe. It is not a Harbor container or GPU training experiment.
"""

import asyncio
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from episode_fixture import EpisodeFixture
from gear.training.adapters.hitch import HitchClient
from gear.training.data.trajectories import RawTrajectory
from gear.training.inference.gateway import ExactGateway
from gear.training.pipelines import diagevo_challenger, diagevo_solver
from gear.training.recipes.diagevo_data import _capture
from gear.training.storage.content import ContractError


class TextHarnessContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_harness_capability_is_required(self):
        client = HitchClient(["fixture"], "/unused")
        caps = dict.fromkeys(
            ("training_external_binding", "exact_policy_tokens", "training_policy_fencing"), "1"
        )
        client.call = AsyncMock(return_value={**caps, "training_harnesses": ["training-tool"]})
        with self.assertRaisesRegex(ContractError, "requested fixed training harness"):
            await client.capabilities("model-call")
        client.call.return_value = {**caps, "training_harnesses": ["model-call"]}
        self.assertEqual(
            (await client.capabilities("model-call"))["training_harnesses"], ["model-call"]
        )
        with self.assertRaises(ContractError):
            await client.capabilities("codex")

    async def test_native_factories_reject_tool_harness_before_loading_models_or_curricula(self):
        runtime = SimpleNamespace(request={"fixedHarness": {"adapter": "training-tool"}})
        for pipeline in (diagevo_solver, diagevo_challenger):
            with (
                self.subTest(pipeline=pipeline.__name__),
                self.assertRaisesRegex(ContractError, "model-call text harness"),
            ):
                pipeline.build_loop({}, runtime)

    @unittest.skipUnless(
        os.environ.get("GEAR_DIAGEVO_HITCH_PATH")
        and shutil.which("node")
        and importlib.util.find_spec("aiohttp"),
        "set GEAR_DIAGEVO_HITCH_PATH to a built Hitch with model-call training support",
    )
    async def test_real_hitch_text_request_is_accepted_by_native_diagevo_capture(self):
        from aiohttp import web

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        f = EpisodeFixture(temporary.name)
        self.addCleanup(f.close)
        f.request["fixedHarness"]["adapter"] = "model-call"
        intent = f.publish()
        native_calls = []
        answer = r"\boxed{2}"

        class Native:
            expected_weight_version = "1"

            async def generate(self, payload):
                native_calls.append(payload)
                tokens = list(answer.encode())
                return {
                    "text": answer,
                    "output_ids": tokens,
                    "meta_info": {
                        "weight_version": "1",
                        "completion_tokens": len(tokens),
                        "output_token_logprobs": [[-0.1, token] for token in tokens],
                        "finish_reason": {"type": "stop"},
                    },
                }

        # Explicit byte-token model double, preserving the actual runner's body.
        def render(body):
            return list("\n".join(m["content"] for m in body["messages"]).encode())

        def parse(data, body, inputs, outputs):
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": data["text"]},
                    }
                ]
            }

        gateway = ExactGateway(
            f.store,
            f.ledger,
            Native(),
            "runtime-1",
            f.ref["digest"],
            f.ref["digest"],
            render,
            parse,
        )
        runner = web.AppRunner(gateway.application())
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        run_id = "run_" + "c" * 32
        prompt = {
            "schema_version": "1",
            "messages": [
                {"role": "system", "content": [{"type": "input_text", "text": "Solve and box."}]},
                {"role": "user", "content": [{"type": "input_text", "text": "What is 1 + 1?"}]},
            ],
        }
        child = await asyncio.create_subprocess_exec(
            shutil.which("node"),
            str(Path(__file__).parent / "fixtures/diagevo_hitch_text.mjs"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                child.communicate(
                    json.dumps(
                        {
                            "binding": intent["binding"],
                            "credential": intent["credential"],
                            "endpoint": f"http://127.0.0.1:{port}/v1",
                            "runId": run_id,
                            "captureRoot": str(Path(temporary.name) / "hitch-capture"),
                            "prompt": prompt,
                        }
                    ).encode()
                ),
                20,
            )
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()
        self.assertEqual(child.returncode, 0, stderr.decode())
        events = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual(len(native_calls), 1)
        self.assertEqual(native_calls[0]["rid"], run_id + "-0")
        result = f.feedback(intent)
        refs = f.journal.receipts(f.address(intent))["receiptRefs"]
        raw = RawTrajectory(
            episode_ref=result["episodeRef"],
            receipt_refs=refs,
            feedback_ref=result["feedbackRef"],
            context_ref=f.store.put_json(f.ledger.context(intent["id"])),
            assembly_ref=result["assemblyRef"],
        )
        sample, _, _, body, text = _capture(f.store, raw, set())
        self.assertEqual(text, answer)
        self.assertNotIn("tools", body)
        self.assertEqual(
            body["messages"],
            [
                {"role": "system", "content": "Solve and box."},
                {"role": "user", "content": "What is 1 + 1?"},
            ],
        )
        self.assertEqual(sample.tokens, render(body) + list(answer.encode()))
        self.assertEqual(
            f.store.read_json(refs[0])["id"],
            next(e for e in events if e["type"] == "provider.response")["receipt_id"],
        )
        self.assertEqual(
            [e for e in events if e["type"] == "training.terminated"],
            [{"type": "training.terminated", "termination": "terminated"}],
        )


if __name__ == "__main__":
    unittest.main()
