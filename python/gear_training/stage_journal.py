"""Small stage request/artifact bridge over authenticated model-node RPC."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from .content import atomic_json, digest_json, require, ContractError
from .state import load, lock


class StageJournal:
    def __init__(self, directory, store): self.directory, self.store = Path(directory), store

    def publish(self, stage, config, payload, lease):
        body = {"schemaVersion": 1, "stage": stage, "config": config, "payloadRef": self.store.put_json(payload),
                "trainingRunId": payload["trainingRunId"], "weightsRef": lease["synchronizedWeightsRef"]}
        identity = digest_json(body)
        path = self.directory / "stage-intents" / identity[7:]
        with lock(path / "intent.lock"):
            old = load(path / "intent.json")
            require(old is None or old == body, "stage-intent-drift", "stage intent changed")
            atomic_json(path / "intent.json", body)
            # A retry can use a new incarnation but the immutable task/result does
            # not change. Lease is a current execution fence, not input identity.
            old_lease = load(path / "lease.json")
            prior_result = load(path / "result.json")
            if old_lease and old_lease != lease and prior_result and prior_result.get("outcome") == "infra-error":
                (path / "result.json").unlink()
            atomic_json(path / "lease.json", lease)
        return identity

    def list(self):
        from .ledger import Ledger
        entries = []; ledger = Ledger(self.directory / "ledger.sqlite")
        try:
            for path in sorted((self.directory / "stage-intents").glob("*/intent.json")):
                lease = load(path.parent / "lease.json")
                cancelled = (self.directory / "cancel.json").exists()
                try: ledger.assert_serving(lease["batchId"], lease["runtimeInstanceId"], lease["fencingToken"])
                except ContractError: cancelled = True
                entries.append({"id": "sha256:" + path.parent.name, "intent": load(path), "lease": lease,
                                "cancelRequested": cancelled, "result": load(path.parent / "result.json")})
        finally: ledger.close()
        return {"entries": entries}

    def inputs(self, identity):
        require(isinstance(identity, str) and identity.startswith("sha256:") and len(identity) == 71 and all(c in "0123456789abcdef" for c in identity[7:]), "invalid-stage-id", "stage identity must be a digest")
        from .ledger import Ledger
        path = self.directory / "stage-intents" / identity[7:]
        body = load(path / "intent.json")
        require(body and digest_json(body) == identity, "stage-input-drift", "unknown stage input")
        payload = self.store.read_json(body["payloadRef"])
        trajectories = payload.get("trajectories", []) if body["stage"] == "dataset-builder" else payload.get("history", [])
        refs = []
        ledger = Ledger(self.directory / "ledger.sqlite")
        try:
            for raw in trajectories:
                episode, context = raw["episode"], raw["context"]
                actual = ledger.context(episode["id"])
                require(actual == context and actual["trainingRunId"] == body["trainingRunId"], "stage-trajectory-drift", "stage history must belong to this exact training journal")
                receipt_refs = ledger.receipts(episode["id"])
                receipts = [self.store.read_json(ref) for ref in receipt_refs]
                require(receipts == raw["receipts"] and episode["receiptIds"] == [item["id"] for item in receipts], "stage-receipt-drift", "stage receipts must be the original native captures")
                refs.extend(receipt_refs)
                for receipt in receipts:
                    refs.extend(receipt[key] for key in ("rawRequestRef", "rawResponseRef", "inputTokenIdsRef", "outputTokenIdsRef", "behaviorLogProbsRef"))
        finally: ledger.close()
        return {"refs": refs}

    def resolve(self, identity, result, *, lease):
        require(identity.startswith("sha256:") and len(identity) == 71 and all(c in "0123456789abcdef" for c in identity[7:]), "invalid-stage-id", "stage identity must be a digest")
        path = self.directory / "stage-intents" / identity[7:]
        with lock(path / "intent.lock"):
            body = load(path / "intent.json")
            require(body and digest_json(body) == identity and load(path / "lease.json") == lease, "stage-address-drift", "stage result belongs to another input or lease")
            require(not (self.directory / "cancel.json").exists(), "cancelled", "job pause rejects late agent output")
            old = load(path / "result.json")
            require(old is None or old == result, "stage-result-conflict", "sealed stage result cannot change")
            if result.get("outcome") == "completed":
                expected = digest_json({"schemaVersion": 1, "stage": body["stage"], "config": body["config"], "payloadDigest": digest_json(self.store.read_json(body["payloadRef"]))})
                require(result["result"].get("inputDigest") == expected, "stage-result-drift", "agent output belongs to another stage input")
                self.store.read_json(result["result"]["outputRef"])
                self.store.read_json(result["result"]["snapshotRef"])
                self.store.read_json(result["result"]["inputRef"])
            else: require(result.get("outcome") == "infra-error", "invalid-stage-result", "stage result needs completed or infra-error outcome")
            atomic_json(path / "result.json", result)
        return {"accepted": True}

    async def execute(self, stage, config, payload, lease, ledger, deadline):
        identity = self.publish(stage, config, payload, lease)
        while True:
            ledger.assert_serving(lease["batchId"], lease["runtimeInstanceId"], lease["fencingToken"])
            require(not (self.directory / "cancel.json").exists(), "cancelled", "job paused during agent stage")
            require(time.monotonic() < deadline, "agent-stage-budget", "training wall/GPU budget ended during agent stage")
            result = load(self.directory / "stage-intents" / identity[7:] / "result.json")
            if result:
                require(result["outcome"] == "completed", "agent-infra-error", result.get("message", "controller agent failed"))
                return result["result"]
            await asyncio.sleep(0.2)
