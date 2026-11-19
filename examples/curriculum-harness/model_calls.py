"""Caller-owned text inference receipts; no curriculum execution layer.

The quota counts submitted SDK turns. It is not an HTTP request/token limit:
the native client may retry internally. Unknown turns are never resubmitted.
"""

from __future__ import annotations

import asyncio
import fcntl
import importlib.metadata
import json
import time
from pathlib import Path

from gear.canonical import digest
from ifeval_experiment import BASE_INSTRUCTIONS, read_json, write_json


class TextCalls:
    def __init__(self, root, *, max_calls=1600, concurrency=4, timeout_seconds=240):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_calls = max_calls
        self.timeout_seconds = timeout_seconds
        self.semaphore = asyncio.Semaphore(concurrency)
        self.client = None

    async def __aenter__(self):
        from openai_codex import AsyncCodex
        from openai_codex.client import CodexConfig

        self.client = AsyncCodex(
            CodexConfig(
                config_overrides=("features.shell_tool=false", 'web_search="disabled"')
            )
        )
        await self.client.__aenter__()
        return self

    async def __aexit__(self, *args):
        return await self.client.__aexit__(*args)

    def directory(self, key):
        return self.root / digest(key).removeprefix("sha256:")

    def _saved(self, directory, request=None):
        path = directory / "result.json"
        if not path.exists():
            return None
        saved = read_json(path)
        if saved["digest"] != digest(saved["receipt"]):
            raise ValueError("model receipt bytes changed")
        if request is not None and saved["request"] != request:
            raise ValueError("model call key was reused with different input")
        pending = read_json(directory / "pending.json")
        if saved["request"] != pending["request"]:
            raise ValueError("model receipt differs from its submission intent")
        if saved["receipt"]["status"] != "completed":
            raise RuntimeError(
                "model turn failed; retained receipt requires explicit recovery"
            )
        return saved["receipt"]

    async def inspect(self, key):
        directory = self.directory(key)
        saved = self._saved(directory)
        if saved is not None:
            return "complete", saved
        path = directory / "pending.json"
        if not path.exists():
            return "not_submitted", None
        prior = read_json(path)
        if not prior.get("thread_id"):
            return "unknown", None
        # Loading a thread and reading its existing turns never starts a turn.
        thread = await self.client.thread_resume(prior["thread_id"])
        snapshot = await thread.read(include_turns=True)
        turns = snapshot.thread.turns
        if len(turns) != 1 or (
            prior.get("turn_id") is not None and turns[0].id != prior["turn_id"]
        ):
            return "unknown", None
        turn = turns[0]
        if turn.status.value != "completed":
            return "unknown", None
        items = [getattr(item, "root", item) for item in turn.items]
        messages = [item for item in items if item.type == "agentMessage"]
        finals = [
            item
            for item in messages
            if getattr(getattr(item, "phase", None), "value", None) == "final_answer"
        ]
        messages = finals or messages
        if not messages:
            return "unknown", None
        receipt = {
            "status": "completed",
            "response": messages[-1].text,
            "usage": None,
            "recovered": True,
            "thread_id": thread.id,
            "turn_id": turn.id,
            "item_types": [item.type for item in items],
        }
        self._store(directory, prior["request"], receipt)
        return "complete", receipt

    @staticmethod
    def _store(directory, request, receipt):
        if any(
            kind not in ("userMessage", "agentMessage", "reasoning")
            for kind in receipt["item_types"]
        ):
            receipt = {**receipt, "status": "unexpected_tool_event"}
        write_json(
            directory / "result.json",
            {"request": request, "receipt": receipt, "digest": digest(receipt)},
        )
        if receipt["status"] != "completed":
            raise RuntimeError(
                "model turn did not complete as tool-free text inference"
            )

    async def call(self, key, prompt, harness, *, model, effort="low"):
        from openai_codex import ApprovalMode, Sandbox

        request = {
            "key": key,
            "model": model,
            "effort": effort,
            "prompt": prompt,
            "harness": harness,
            "base_instructions": BASE_INSTRUCTIONS,
            "tools": False,
            "sdk": importlib.metadata.version("openai-codex"),
        }
        directory = self.directory(key)
        directory.mkdir(parents=True, exist_ok=True)
        async with self.semaphore:
            with (directory / ".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                saved = self._saved(directory, request)
                if saved is not None:
                    return saved
                pending = directory / "pending.json"
                if pending.exists():
                    if read_json(pending)["request"] != request:
                        raise ValueError(
                            "model call input changed while awaiting a result"
                        )
                    status, receipt = await self.inspect(key)
                    if status == "complete":
                        return receipt
                    raise RuntimeError(
                        "unknown model result; reconcile without resubmitting: " + key
                    )
                with (self.root / ".quota.lock").open("a") as quota:
                    fcntl.flock(quota, fcntl.LOCK_EX)
                    if len(list(self.root.glob("*/pending.json"))) >= self.max_calls:
                        raise RuntimeError(
                            "predeclared logical model-call quota exhausted"
                        )
                    write_json(pending, {"request": request})
                thread = await self.client.thread_start(
                    cwd=str(directory),
                    model=model,
                    sandbox=Sandbox.read_only,
                    approval_mode=ApprovalMode.deny_all,
                    base_instructions=BASE_INSTRUCTIONS,
                    developer_instructions=harness,
                )
                write_json(pending, {"request": request, "thread_id": thread.id})
                handle = await thread.turn(prompt, effort=effort)
                write_json(
                    pending,
                    {"request": request, "thread_id": thread.id, "turn_id": handle.id},
                )
                started = time.monotonic()
                result = await asyncio.wait_for(handle.run(), self.timeout_seconds)
                receipt = {
                    "status": result.status.value,
                    "response": result.final_response or "",
                    "usage": result.usage.model_dump(mode="json")
                    if result.usage
                    else None,
                    "thread_id": thread.id,
                    "turn_id": result.id,
                    "seconds": time.monotonic() - started,
                    "item_types": [
                        getattr(item, "root", item).type for item in result.items
                    ],
                }
                self._store(directory, request, receipt)
                return receipt


def token_usage(receipts):
    """Report tokens only if every turn has native usage; never infer HTTP counts."""
    if any(receipt["usage"] is None for receipt in receipts):
        return {}
    return {
        "tokens": sum(receipt["usage"]["total"]["total_tokens"] for receipt in receipts)
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Read-only model availability probe")
    parser.add_argument("--root", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    async def probe():
        async with TextCalls(args.root, max_calls=1) as calls:
            receipt = await calls.call(
                "availability",
                "Return exactly OK",
                "Follow the instruction.",
                model=args.model,
            )
        print(json.dumps({"response": receipt["response"], "usage": receipt["usage"]}))

    asyncio.run(probe())
