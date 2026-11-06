"""Slime hook for already sealed offline supervision."""

import json
import os
from pathlib import Path

from gear.training.data.offline import seal_batch, validate_batch
from gear.training.storage.content import ContentStore, atomic_json, require


def generate_rollout(args, rollout_id, data_source, evaluation=False):
    require(
        not evaluation,
        "evaluation-isolation",
        "offline SFT never consumes evaluation data",
    )
    from slime.rollout.base_types import RolloutFnTrainOutput
    from slime.utils.types import Sample

    directory = Path(os.environ["GEAR_TRAINING_JOB"])
    request = json.loads((directory / "request.json").read_text())
    config = json.loads((directory / "config.json").read_text())
    store = ContentStore(config["storeRoot"])
    replay_path = directory / "offline-replay.json"
    if replay_path.exists():
        replay = json.loads(replay_path.read_text())
        require(
            replay.get("rolloutId") == rollout_id,
            "runtime-cursor-mismatch",
            "sealed offline replay belongs to another update",
        )
        batch_ref = replay["batchRef"]
        batch = validate_batch(store, request, batch_ref, rollout_id)
    else:
        require(
            not request["trainer"].get("script"),
            "missing-offline-batch",
            "four-stage SFT requires its builder's sealed batch",
        )
        batch_ref = seal_batch(store, request, rollout_id)
        batch = store.read_json(batch_ref)
    atomic_json(directory / "batch.json", {"rolloutId": rollout_id, "batchRef": batch_ref})
    result = []
    for i, record in enumerate(store.read_json(batch["samplesRef"])):
        first = record["lossMask"].index(1)
        sample = Sample(
            index=i,
            group_index=i,
            prompt="",
            tokens=record["tokens"],
            response_length=len(record["tokens"]) - first,
            loss_mask=record["lossMask"][first:],
            reward=0,
            metadata={"offlineRecordId": record["id"]},
        )
        sample.status = Sample.Status.COMPLETED
        sample.rollout_id = rollout_id * len(batch["recordRefs"]) + i
        result.append([sample])
    return RolloutFnTrainOutput(samples=result, metrics={"gear/offline_examples": len(result)})
