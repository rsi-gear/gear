"""Four logical training stages over the existing synchronous driver and CAS.

RawTrajectory is evidence, not an admitted gradient sample. The strict GRPO
builder remains authoritative for token IDs, masks, logprobs and verifier reward.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol
from .agents import AgentRequest, AgentRunner, CodexRunner
from .content import ContentStore, ContractError, atomic_json, digest_json, require
from .export import materialize, seal_directory
from .samples import build_episode, admit_group
from .state import load, lock


class TaskSource(Protocol):
    async def tasks(self, rollout_id: int) -> list[dict]: ...


class RolloutExecutor(Protocol):
    async def execute(self, context: dict): ...


class DatasetBuilder(Protocol):
    async def build(self, trajectories: list): ...


class ModelUpdater(Protocol):
    def update(self, rollout_id: int, rollout_data): ...


@dataclass(frozen=True)
class RawTrajectory:
    episode_ref: dict
    feedback_ref: dict
    receipt_refs: list
    context_ref: dict
    assembly_ref: dict | None = None

    def refs(self):
        return [self.episode_ref, self.feedback_ref, *self.receipt_refs, self.context_ref, *([self.assembly_ref] if self.assembly_ref else [])]


def persist_trajectory(store, directory, episode, feedback, receipt_refs, context, assembly=None):
    raw = RawTrajectory(store.put_json(episode), store.put_json(feedback), receipt_refs, store.put_json(context),
                        store.put_json(assembly) if assembly is not None else None)
    ref = store.put_json({"schemaVersion": 1, "kind": "raw-trajectory", **asdict(raw)})
    atomic_json(Path(directory) / "trajectories" / (digest_json(episode["id"])[7:] + ".json"), {"trajectoryRef": ref})
    return raw, ref


class FrozenTaskSource:
    def __init__(self, request): self.request = request

    async def tasks(self, rollout_id):
        tasks = self.request["trainDataset"]["tasks"]
        start = rollout_id * self.request["trainer"]["rolloutBatchSize"]
        return [tasks[(start + i) % len(tasks)] for i in range(len(tasks))]


class HitchRolloutExecutor:
    """Uses the existing canonical Hitch/episode coordinator, including leases."""
    def __init__(self, execute): self._execute = execute
    async def execute(self, context): return await self._execute(context)


class GRPODatasetBuilder:
    def __init__(self, store, request): self.store, self.request = store, request

    async def build(self, trajectories):
        samples = []
        for raw in trajectories:
            samples.append(build_episode(self.store, self.store.read_json(raw.episode_ref),
                [self.store.read_json(ref) for ref in raw.receipt_refs], self.store.read_json(raw.feedback_ref),
                self.store.read_json(raw.context_ref), assembly=self.store.read_json(raw.assembly_ref) if raw.assembly_ref else None))
        return admit_group(samples, self.request["rollout"]["groupSize"], self.request["rollout"]["zeroVarianceGroup"])


class SlimeModelUpdater:
    """Slime owns optimizer/save; driver retains pending-export/commit recovery."""
    def __init__(self, memory): self.memory = memory
    def update(self, rollout_id, rollout_data): self.memory.train_and_save(rollout_id, rollout_data)


def training_identity(request):
    parent_ref = request.get("parentModelRef", request["parentModel"]["hfSnapshotRef"])
    behavior = request.get("behaviorPolicyRef", parent_ref)
    start = request.get("updateStart", {"mode": "resume" if request.get("resumeCheckpointRef") else "cold-start",
                                       "checkpointRef": request.get("resumeCheckpointRef"), "modelRef": parent_ref})
    require(behavior == parent_ref, "off-policy-grpo", "this GRPO backend requires the synchronized actor as behavior policy")
    require(start.get("modelRef") == parent_ref and start.get("mode") == ("resume" if request.get("resumeCheckpointRef") else "cold-start")
            and start.get("checkpointRef") == request.get("resumeCheckpointRef"), "unsupported-update-start", "GRPO must resume full champion state or explicitly cold start its initial weights")
    require(request.get("referenceModelRef"), "missing-objective-reference", "the existing GRPO objective requires its sealed reference")
    return {"behaviorPolicyRef": behavior, "updateStart": start, "referenceModelRef": request["referenceModelRef"]}


from .agent_stage import run_agent_stage


class AgentTaskSource:
    def __init__(self, store, request, execute, *, weights_ref=None, history=None):
        self.store, self.request, self.execute = store, request, execute
        self.weights_ref, self.history = weights_ref, history or []
    async def tasks(self, rollout_id):
        config = self.request["stages"]["taskSource"]
        payload = {"rolloutId": rollout_id, "trainingRunId": self.request["trainingRunId"],
                   "behaviorPolicyRef": self.weights_ref or self.request.get("behaviorPolicyRef", self.request["parentModelRef"]), "history": self.history,
                   "tasks": self.request["trainDataset"]["tasks"], "maxTasks": self.request["trainer"]["rolloutBatchSize"] + self.request["budgets"]["maxGroupResamples"]}
        result = await self.execute("task-source", config, payload)
        output = self.store.read_json(result["outputRef"])
        require(isinstance(output.get("tasks"), list) and output["tasks"], "invalid-agent-tasks", "sealed task source is empty")
        return output["tasks"]


class AgentDatasetBuilder:
    def __init__(self, store, request, execute):
        self.store, self.request, self.execute = store, request, execute
        self.trusted = GRPODatasetBuilder(store, request)
    async def build(self, trajectories):
        payload = {"trainingRunId": self.request["trainingRunId"], "trajectories": [
            {"episode": self.store.read_json(t.episode_ref), "feedback": self.store.read_json(t.feedback_ref),
             "receipts": [self.store.read_json(ref) for ref in t.receipt_refs], "context": self.store.read_json(t.context_ref)} for t in trajectories]}
        result = await self.execute("dataset-builder", self.request["stages"]["datasetBuilder"], payload)
        output = self.store.read_json(result["outputRef"])
        require(output["selectedEpisodeIds"] == [item["episode"]["id"] for item in payload["trajectories"]], "agent-group-rejected", "dataset agent rejected the whole GRPO group")
        return await self.trusted.build(trajectories)


class SFTDatasetBuilder:
    """Data construction only. Prefix requires explicit independent step evidence.

    A final failure/score never implies a first error boundary. Exact receipts
    are copied by the trusted builder; an agent may only select a verified cut.
    """
    def __init__(self, store): self.store = store
    async def build(self, trajectories, *, verifications=None):
        prefixes = verifications or {}; samples = []
        for raw in trajectories:
            if raw.episode_ref.get("digest") is None: raise ContractError("invalid-trajectory", "trajectory is not sealed")
            episode = self.store.read_json(raw.episode_ref); feedback = self.store.read_json(raw.feedback_ref)
            context = self.store.read_json(raw.context_ref)
            selected = list(raw.receipt_refs)
            proof_ref = prefixes.get(episode["id"])
            if not proof_ref: continue
            proof = self.store.read_json(proof_ref)
            count = proof.get("receiptCount", len(selected))
            require(proof.get("kind") in ("verified-success", "verified-prefix") and proof.get("episodeId") == episode["id"] and proof.get("runId") == episode["runId"]
                    and type(count) is int and 0 < count <= len(selected) and proof.get("verified") is True
                    and proof.get("receiptDigests") == [ref["digest"] for ref in selected[:count]], "invalid-prefix-proof", "selection needs independently verified ordered receipt evidence")
            require(proof["kind"] != "verified-success" or count == len(selected) and episode.get("termination") == "terminated" and feedback.get("outcome") == "valid",
                    "invalid-success-proof", "success requires a valid complete canonical episode")
            self.store.read_bytes(proof["evidenceRef"])
            from .samples import build_capture
            sample = build_capture(self.store, episode, [self.store.read_json(ref) for ref in raw.receipt_refs], feedback, context, receipt_count=count, assembly=self.store.read_json(raw.assembly_ref) if raw.assembly_ref else None)
            samples.append({"tokens": sample.tokens, "responseLength": sample.response_length, "lossMask": sample.loss_mask,
                            "sourceTrajectory": asdict(raw), "prefixProofRef": prefixes.get(episode["id"])})
        return self.store.put_json({"schemaVersion": 1, "kind": "sft-dataset", "samples": samples})


def main():
    import argparse
    import sys
    parser = argparse.ArgumentParser()
    parser.add_argument("--store-root", required=True); parser.add_argument("--workspace", required=True)
    parser.add_argument("--execution-root"); parser.add_argument("--response-file"); parser.add_argument("--stop", action="store_true"); parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    response = Path(args.response_file) if args.response_file else None
    execution = Path(args.execution_root or args.workspace)
    if args.inspect:
        from .recovery import owned_alive
        owner = load(execution / "worker.json")
        print(json.dumps({"alive": bool(owner and owned_alive(owner))})); return
    if args.stop:
        atomic_json(execution / "cancel.json", {"cancelled": True})
        from .recovery import stop_owned
        owner = load(execution / "worker.json")
        if owner:
            import psutil
            from .recovery import owned_alive, process_identity
            if owned_alive(owner):
                descendants = [process_identity(p.pid) for p in psutil.Process(owner["pid"]).children(recursive=True)]
                stop_owned([owner, *[p for p in descendants if p]])
        print(json.dumps({"stopped": True})); return
    payload = json.load(sys.stdin)
    if response:
        import os
        from .recovery import process_identity
        atomic_json(execution / "worker.json", process_identity(os.getpid()))
    try:
        result = asyncio.run(run_agent_stage(ContentStore(args.store_root), args.workspace, payload["stage"], payload["config"], payload["payload"], cancel_path=execution / "cancel.json"))
        if response: atomic_json(response, {"outcome": "completed", "result": result})
        else: print(json.dumps(result))
    except Exception as error:
        if response: atomic_json(response, {"outcome": "infra-error", "message": str(error)})
        else: print(json.dumps({"error": {"code": getattr(error, "code", "stage-error"), "message": str(error)}}))
        sys.exit(1)


if __name__ == "__main__": main()
