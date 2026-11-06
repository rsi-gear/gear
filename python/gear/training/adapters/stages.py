"""Four logical training stages over the existing synchronous driver and CAS.

RawTrajectory is evidence, not an admitted gradient sample. The strict GRPO
builder remains authoritative for token IDs, masks, logprobs and verifier reward.
"""

from __future__ import annotations

from gear.training.data.builders import GRPODatasetBuilder
from gear.training.storage.content import require


class FrozenTaskSource:
    def __init__(self, request):
        self.request = request

    async def tasks(self, rollout_id):
        tasks = self.request["trainDataset"]["tasks"]
        start = rollout_id * self.request["trainer"]["rolloutBatchSize"]
        return [tasks[(start + i) % len(tasks)] for i in range(len(tasks))]


class HitchRolloutExecutor:
    """Uses the existing canonical Hitch/episode coordinator, including leases."""

    def __init__(self, execute):
        self._execute = execute

    async def execute(self, context):
        return await self._execute(context)


class AgentTaskSource:
    def __init__(self, store, request, execute, *, weights_ref=None, history=None):
        self.store, self.request, self.execute = store, request, execute
        self.weights_ref, self.history = weights_ref, history or []

    async def tasks(self, rollout_id):
        config = self.request["stages"]["taskSource"]
        payload = {
            "rolloutId": rollout_id,
            "trainingRunId": self.request["trainingRunId"],
            "behaviorPolicyRef": self.weights_ref
            or self.request.get("behaviorPolicyRef", self.request["parentModelRef"]),
            "history": self.history,
            "tasks": self.request["trainDataset"]["tasks"],
            "maxTasks": self.request["trainer"]["rolloutBatchSize"]
            + self.request["budgets"]["maxGroupResamples"],
        }
        result = await self.execute("task-source", config, payload)
        output = self.store.read_json(result["outputRef"])
        require(
            isinstance(output.get("tasks"), list) and output["tasks"],
            "invalid-agent-tasks",
            "sealed task source is empty",
        )
        return output["tasks"]


class AgentDatasetBuilder:
    def __init__(self, store, request, execute):
        self.store, self.request, self.execute = store, request, execute
        self.trusted = GRPODatasetBuilder(store, request)

    async def build(self, trajectories):
        payload = {
            "trainingRunId": self.request["trainingRunId"],
            "trajectories": [
                {
                    "episode": self.store.read_json(t.episode_ref),
                    "feedback": self.store.read_json(t.feedback_ref),
                    "receipts": [self.store.read_json(ref) for ref in t.receipt_refs],
                    "context": self.store.read_json(t.context_ref),
                }
                for t in trajectories
            ],
        }
        result = await self.execute(
            "dataset-builder", self.request["stages"]["datasetBuilder"], payload
        )
        output = self.store.read_json(result["outputRef"])
        require(
            output["selectedEpisodeIds"]
            == [item["episode"]["id"] for item in payload["trajectories"]],
            "agent-group-rejected",
            "dataset agent rejected the whole GRPO group",
        )
        return await self.trusted.build(trajectories)
