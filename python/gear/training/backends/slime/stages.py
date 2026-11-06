"""Slime update lifecycle and frozen behavior/reference policy identity."""

from gear.training.recipes.registry import is_sft
from gear.training.storage.content import require


class SlimeModelUpdater:
    """Slime owns optimizer/save; driver retains pending-export/commit recovery."""

    def __init__(self, memory):
        self.memory = memory

    def update(self, rollout_id, rollout_data):
        self.memory.train_and_save(rollout_id, rollout_data)


def training_identity(request):
    parent_ref = request.get("parentModelRef", request["parentModel"]["hfSnapshotRef"])
    behavior = request.get("behaviorPolicyRef", parent_ref)
    start = request.get(
        "updateStart",
        {
            "mode": "resume" if request.get("resumeCheckpointRef") else "cold-start",
            "checkpointRef": request.get("resumeCheckpointRef"),
            "modelRef": parent_ref,
        },
    )
    offline = is_sft(request)
    require(
        offline or behavior == parent_ref,
        "off-policy-grpo",
        "online RL requires the synchronized actor as behavior policy",
    )
    require(
        start.get("modelRef") == parent_ref
        and start.get("mode") == ("resume" if request.get("resumeCheckpointRef") else "cold-start")
        and start.get("checkpointRef") == request.get("resumeCheckpointRef"),
        "unsupported-update-start",
        "GRPO must resume full champion state or explicitly cold start its initial weights",
    )
    require(
        offline or request.get("referenceModelRef"),
        "missing-objective-reference",
        "online RL requires its sealed objective reference",
    )
    return {
        "behaviorPolicyRef": None if offline else behavior,
        "updateStart": start,
        "referenceModelRef": None if offline else request["referenceModelRef"],
    }
