"""Synchronous orchestration using Slime's public Ray actor and rollout APIs.

No optimizer or loss is implemented here. Every backward, save and weight
transfer is performed by the pinned Slime Megatron backend.
"""
from __future__ import annotations

import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .content import ContentStore, atomic_json, digest_json, require
from .export import materialize, commit_checkpoint
from .ledger import Ledger
from .preflight import compatibility_digest
from .placement import TrainingMemoryCycle, resource_plan, validate_resource_args
from .recipes.agent_grpo import sampling_params


RESERVED = {"--load", "--ref-load", "--hf-checkpoint", "--save", "--save-hf", "--save-interval", "--num-rollout", "--start-rollout-id",
            "--rollout-function-path", "--custom-generate-function-path", "--rollout-batch-size", "--n-samples-per-prompt", "--global-batch-size",
            "--advantage-estimator", "--rollout-temperature", "--rollout-top-p", "--rollout-top-k", "--rollout-max-response-len", "--train-backend",
            "--ref-update-interval", "--no-save-optim", "--no-save-rng", "--no-load-optim", "--no-load-rng", "--finetune",
            "--debug-train-only", "--debug-rollout-only", "--load-debug-rollout-data", "--async-save", "--colocate", "--offload", "--offload-train", "--offload-rollout",
            "--no-offload-train", "--no-offload-rollout", "--megatron-config-path", "--sglang-config", "--prefill-num-servers",
            "--release-train", "--rollout-external", "--use-critic", "--use-fault-tolerance", "--eval-interval", "--num-epoch", "--use-rollout-logprobs", "--custom-rm-path", "--custom-reward-post-process-path", "--custom-loss-function-path"}


def build_argv(request, hyperparameters, paths, start_update):
    args = hyperparameters.get("slimeArgs")
    require(hyperparameters.get("schemaVersion") == 1 and isinstance(args, list) and all(isinstance(a, str) and a for a in args), "invalid-hyperparameters", "recipe must contain an explicit sealed Slime argv array")
    require(not any(a.split("=", 1)[0] in RESERVED or a.startswith("--custom-") or (a.startswith("--") and a.split("=", 1)[0].endswith("-function-path")) for a in args), "reserved-slime-override", "recipe cannot override lifecycle, identity, grouping, reference or checkpoint arguments")
    # Model size, TP/PP, optimizer, learning rate, KL, clipping and epochs are
    # user-selected and sealed; never invent a GPU-fit or learning-rate default.
    for flag in ("--lr", "--kl-coef", "--eps-clip", "--num-steps-per-rollout"):
        require(flag in args or any(a.startswith(flag + "=") for a in args), "unsealed-hyperparameter", "recipe must explicitly set " + flag)
    t, r = request["trainer"], request["rollout"]
    placement, resources, args = resource_plan(request, args)
    fixed = {"--load": paths["load"], "--ref-load": paths["reference"], "--hf-checkpoint": paths["hf"], "--save": paths["save"],
             "--save-interval": 1, "--num-rollout": start_update + t["updatesPerCandidate"],
             "--start-rollout-id": start_update, "--rollout-function-path": "gear_training.rollout.generate_rollout",
             "--rollout-batch-size": t["rolloutBatchSize"], "--n-samples-per-prompt": r["groupSize"], "--global-batch-size": t["globalBatchSize"],
             "--advantage-estimator": "grpo", "--rollout-temperature": 1, "--rollout-top-p": 1, "--rollout-top-k": -1,
             "--rollout-max-response-len": r["sampling"]["maxNewTokens"], "--train-backend": "megatron", **resources}
    memory = ["--colocate", "--offload-train", "--offload-rollout"] if placement == "colocated" else ["--no-offload-train", "--no-offload-rollout"]
    return [*args, *memory, "--use-rollout-logprobs", *(item for key, value in fixed.items() for item in (key, str(value)))]


def export_committed_actor(actor, store, ledger, *, export_root, **checkpoint_args):
    # Never reuse a partial HF directory left by an interrupted shard writer.
    destination = Path(export_root) / (str(checkpoint_args["committed_update"]) + "-" + secrets.token_hex(12))
    actor.export_hf(str(destination))
    return commit_checkpoint(store, ledger, hf_directory=destination, **checkpoint_args)


def create_policy_lease(request, batch_id, policy, current_hf, incarnation):
    return {"schemaVersion": 1, "trainingRunId": request["trainingRunId"], "batchId": batch_id, "policyVersion": policy,
            "parentModelVersionId": request["parentModel"]["id"], "synchronizedWeightsRef": current_hf, "runtimeInstanceId": incarnation,
            # The lease fences the actual native parameters, also used by the
            # rollout gateway and controller, rather than the spec field names.
            "samplingDigest": digest_json(sampling_params(request["rollout"])), "fencingToken": secrets.token_hex(24),
            "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=request["budgets"]["totalGpuSeconds"] / len(request["trainingDevices"]))).isoformat(), "state": "serving"}


def finalize_candidate(job_dir, request, store, prior_commits, checkpoint_ref, outcome, committed):
    if outcome == "completed":
        require(checkpoint_ref and len(prior_commits) == request["trainer"]["updatesPerCandidate"], "incomplete-training-run", "candidate must finish the configured number of updates")
        checkpoint = store.read_json(checkpoint_ref); hf_manifest = store.read_json(checkpoint["hfExportRef"])
        provenance = store.put_json({"schemaVersion": 1, "requestDigest": digest_json(request), "recipeDigest": request["recipeDigest"], "updateCommitRefs": prior_commits})
        body = {"schemaVersion": 1, "parentModelVersionId": request["parentModel"]["id"], "hfSnapshotRef": checkpoint["hfExportRef"],
                **{k: hf_manifest[k] for k in ("weightsDigest", "tokenizerDigest", "chatTemplateDigest", "architecture", "dtype")},
                "trainingRunId": request["trainingRunId"], "trainerCheckpointRef": checkpoint_ref, "provenanceRef": provenance}
        validation = store.put_json({"schemaVersion": 1, "valid": True, "weightsDigest": checkpoint["actorWeightsDigest"],
                                    "hfSnapshotDigest": checkpoint["hfExportRef"]["digest"], "checkpointDigest": checkpoint_ref["digest"],
                                    "source": "slime-megatron-synchronous-save-and-hf-export", "runtimeProbeRefs": request["trainer"]["runtimeLock"]["probeEvidenceRefs"]})
        atomic_json(job_dir / "artifacts.body.json", {"model": {**body, "id": digest_json(body)}, "checkpointRef": checkpoint_ref,
                    "updateCommitRefs": prior_commits, "exportValidationRef": validation})
    if prior_commits:
        atomic_json(job_dir / "progress.json", {"phase": "checkpointed", "committedUpdate": committed, "latestCommitRef": prior_commits[-1]})
    atomic_json(job_dir / "outcome.json", {"outcome": outcome, "committedUpdate": committed})



class SlimeRoundRuntime:
    """Shared native round lifecycle for legacy orchestration and public recipe."""
    def __init__(self, job_dir, request, config, store, ledger, paths, parent_start, start,
                 prior_commits, checkpoint_ref, current_hf, *, args=None, ray=None, memory=None, manager=None, incarnation=None):
        self.job_dir, self.request, self.config, self.store, self.ledger = job_dir, request, config, store, ledger
        self.paths, self.parent_start, self.committed = paths, parent_start, start
        self.prior_commits, self.checkpoint_ref, self.current_hf = prior_commits, checkpoint_ref, current_hf
        self.args, self.ray, self.memory, self.manager, self.incarnation = args, ray, memory, manager, incarnation

    def check_cancel(self):
        require(not (self.job_dir / "cancel.json").exists(), "cancelled", "training pause requested")

    def prepare_round(self, rollout_id, *, checkpoint=None):
        self.check_cancel()
        require(rollout_id == self.committed, "runtime-cursor-mismatch", "collection must start at the native committed cursor")
        if checkpoint is not None:
            require(checkpoint["committedUpdate"] == rollout_id and checkpoint["hfSnapshotRef"] == self.current_hf,
                    "replay-pre-update-mismatch", "public checkpoint differs from the loaded native actor")
        require(self.memory is not None, "missing-slime-runtime", "remaining updates require the native Slime runtime")
        self.memory.prepare_rollout(compare_weights=self.args.check_weight_update_equal and rollout_id == 0)
        engines, _, _, _, _, _ = self.ray.get(self.manager.get_updatable_engines_and_lock.remote())
        versions = self.ray.get([engine.get_weight_version.remote() for engine in engines])
        urls = self.ray.get([engine.get_url.remote() for engine in engines])
        active = [(url, str(version)) for url, version in zip(urls, versions) if url is not None]
        require(active and len({v for _, v in active}) == 1, "unsynchronized-replicas", "rollout replicas disagree on current weights")
        policy = f"{self.incarnation}/update-{rollout_id}/weight-{active[0][1]}"
        batch_id = f"batch_{self.incarnation}_{rollout_id}"
        lease = create_policy_lease(self.request, batch_id, policy, self.current_hf, self.incarnation)
        replay = None
        prior_batch = json.loads((self.job_dir / "batch.json").read_text()) if (self.job_dir / "batch.json").exists() else None
        if prior_batch and prior_batch["rolloutId"] == rollout_id:
            sealed = self.store.read_json(prior_batch["batchRef"])
            source = self.ledger.db.execute("SELECT body,state FROM leases WHERE json_extract(body,'$.policyVersion')=?", (sealed["policyVersion"],)).fetchone()
            require(source and source["state"] == "closed" and json.loads(source["body"])["synchronizedWeightsRef"]["digest"] == self.current_hf["digest"],
                    "replay-pre-update-mismatch", "sealed batch replay requires its exact original pre-update actor weights")
            replay = prior_batch["batchRef"]
            batch_id = json.loads(source["body"])["batchId"]
        self.batch_id, self.replay = batch_id, replay
        atomic_json(self.job_dir / "runtime.json", {"rolloutId": rollout_id, "lease": lease, "engineUrl": active[0][0], "weightVersion": active[0][1],
            "replicas": [{"replicaId": url, "weightsDigest": self.current_hf["digest"], "policyVersion": policy, "runtimeInstanceId": self.incarnation} for url, _ in active],
            **({"replayBatchRef": replay, "replayRuntimeInstanceId": self.incarnation} if replay else {})})
        atomic_json(self.job_dir / "progress.json", {"phase": "collecting", "committedUpdate": self.committed})

    def train_commit(self, rollout_id, rollout_data, batch):
        def batch_barrier():
            sealed = self.ledger.db.execute("SELECT ref FROM batches WHERE batch=?", (self.batch_id,)).fetchone()
            require(batch["rolloutId"] == rollout_id and self.ledger.lease(self.batch_id)["state"] == "closed"
                    and sealed and json.loads(sealed[0]) == batch["batchRef"],
                    "missing-batch-barrier", "optimizer and rollout offload cannot start before durable batch sealing")
        self.memory.finish_rollout(batch_barrier)
        atomic_json(self.job_dir / "progress.json", {"phase": "training", "committedUpdate": self.committed, "batchRef": batch["batchRef"]})
        from .stages import SlimeModelUpdater
        SlimeModelUpdater(self.memory).update(rollout_id, rollout_data)
        if self.args.rollout_global_dataset: self.ray.get(self.manager.save.remote(rollout_id))
        from .export import seal_directory
        trainer_ref = seal_directory(self.store, self.paths["save"])
        data_cursor = {"committedUpdate": rollout_id + 1, "batchRef": batch["batchRef"], "groupResamples": self.ledger.usage()["groupResamples"]}
        if self.replay: data_cursor["replayOfBatch"] = self.replay["digest"]
        atomic_json(self.job_dir / "pending-update.json", {"committedUpdate": rollout_id + 1, "trainerStateRef": trainer_ref,
            "batchRef": batch["batchRef"], "dataCursor": data_cursor, "compatibilityDigest": compatibility_digest(self.request)})
        atomic_json(self.job_dir / "progress.json", {"phase": "exporting", "committedUpdate": self.committed, "batchRef": batch["batchRef"]})
        checkpoint_ref, commit_ref = export_committed_actor(self.memory, self.store, self.ledger, export_root=self.paths["export"], request=self.request, committed_update=rollout_id + 1,
            trainer_directory=self.paths["save"], trainer_state_ref=trainer_ref, data_cursor=data_cursor, rng_state_ref=trainer_ref,
            compatibility_digest=compatibility_digest(self.request), batch_ref=batch["batchRef"], previous_commit=self.prior_commits[-1] if self.prior_commits else None)
        self.prior_commits.append(commit_ref); self.committed = rollout_id + 1; self.checkpoint_ref = checkpoint_ref
        (self.job_dir / "pending-update.json").unlink()
        self.current_hf = self.store.read_json(checkpoint_ref)["hfExportRef"]
        atomic_json(self.job_dir / "progress.json", {"phase": "checkpointed", "committedUpdate": self.committed, "latestCommitRef": commit_ref})
        self.memory.complete_update()
        return self.checkpoint_value(checkpoint_ref, commit_ref)

    def checkpoint_value(self, checkpoint_ref, commit_ref):
        checkpoint = self.store.read_json(checkpoint_ref)
        return {"checkpointRef": checkpoint_ref, "hfSnapshotRef": checkpoint["hfExportRef"],
                "committedUpdate": checkpoint["committedUpdate"], "commitRef": commit_ref}

    def update_dataset(self, rollout_id, dataset, checkpoint, operation_id):
        require(dataset.get("kind") == "grpo-dataset" and dataset.get("schemaVersion") == 1 and dataset.get("rolloutId") == rollout_id
                and dataset.get("preUpdateHfRef") == checkpoint["hfSnapshotRef"] and checkpoint["committedUpdate"] == rollout_id,
                "grpo-dataset-drift", "updater must consume this round's sealed pre-update dataset")
        batch_ref = dataset["batchRef"]
        row = self.ledger.db.execute("SELECT batch_digest,ref FROM commits WHERE update_number=?", (rollout_id + 1,)).fetchone()
        if row:
            require(row["batch_digest"] == batch_ref["digest"], "update-conflict", "native commit consumed another batch")
            ref = json.loads(row["ref"]); commit = self.store.read_json(ref)
            return self.checkpoint_value(commit["checkpointRef"], ref)
        self.check_cancel()
        require(self.committed == rollout_id and self.current_hf == checkpoint["hfSnapshotRef"],
                "replay-pre-update-mismatch", "dataset replay requires the original pre-update actor")
        batch = self.store.read_json(batch_ref)
        require(batch["trainingRunId"] == self.request["trainingRunId"] and batch["recipeDigest"] == self.request["recipeDigest"]
                and batch["datasetSplitDigest"] == self.request["datasetSplitDigest"], "invalid-replay-batch", "dataset belongs to another frozen request")
        lease = self.ledger.lease(dataset["batchId"])
        require(lease["state"] == "closed" and lease["policyVersion"] == batch["policyVersion"]
                and lease["synchronizedWeightsRef"] == self.current_hf, "replay-pre-update-mismatch", "dataset must retain its closed original policy")
        # Raw collection may have been cached across driver incarnations. Wake
        # the same pre-update model before the pinned Slime preprocessing call.
        if self.memory.phase == "checkpoint": self.prepare_round(rollout_id, checkpoint=checkpoint)
        # The hook projects a sealed batch even on the first attempt. Only
        # prepare_round marks an actual recovered batch as replay provenance.
        self.batch_id = dataset["batchId"]
        runtime = json.loads((self.job_dir / "runtime.json").read_text())
        runtime.update(replayBatchRef=batch_ref, replayRuntimeInstanceId=self.incarnation)
        atomic_json(self.job_dir / "runtime.json", runtime)
        atomic_json(self.job_dir / "batch.json", {"rolloutId": rollout_id, "batchRef": batch_ref})
        rollout_data = self.ray.get(self.manager.generate.remote(rollout_id))
        return self.train_commit(rollout_id, rollout_data, {"rolloutId": rollout_id, "batchRef": batch_ref})


def _run_public_recipe(runtime):
    from .dev_grpo import build_loop, loop_config
    return build_loop(runtime).run(loop_config(runtime))


def run(job_dir):
    job_dir = Path(job_dir)
    request = json.loads((job_dir / "request.json").read_text())
    config = json.loads((job_dir / "config.json").read_text())
    require(request["trainer"].get("pipeline") in (None, "four-stage"), "unsupported-training-pipeline", "unknown trainer pipeline")
    store, ledger = ContentStore(config["storeRoot"]), Ledger(job_dir / "ledger.sqlite")
    from .recovery import update_recovery
    from .stages import training_identity
    training_identity(request)
    recovered = update_recovery(job_dir, request, store, ledger)
    prior_commits, resume_ref, pending = recovered["commitRefs"], recovered["checkpointRef"], recovered["pending"]
    parent_start, start = recovered["parentStart"], recovered["start"]
    four_stage = request["trainer"].get("pipeline") == "four-stage"
    if four_stage:
        require(not request.get("stages"), "unsupported-preset-stages", "the dev GRPO preset uses frozen tasks and the strict trusted builder")
        require(not (prior_commits or pending or ledger.db.execute("SELECT batch FROM batches LIMIT 1").fetchone()
                     or ledger.db.execute("SELECT id FROM episodes LIMIT 1").fetchone()) or (job_dir / "four-stage-loop/identity.json").is_file(),
                "missing-preset-history", "legacy jobs cannot upgrade to the public preset without their original stage artifacts")
    if len(prior_commits) == request["trainer"]["updatesPerCandidate"]:
        # SQLite already committed every update. A lost completion response
        # requires only immutable artifact publication, not CUDA or Ray startup.
        try:
            if four_stage:
                checkpoint = store.read_json(resume_ref)
                runtime = SlimeRoundRuntime(job_dir, request, config, store, ledger, {}, parent_start, start,
                    prior_commits, resume_ref, checkpoint["hfExportRef"])
                _run_public_recipe(runtime)
            finalize_candidate(job_dir, request, store, prior_commits, resume_ref, "completed", start)
        finally: ledger.close()
        return
    from .execution import training_devices
    from .gpu_visibility import verify_visible_devices
    verify_visible_devices(training_devices(request))
    sys.path.insert(0, config["slimePath"])
    reference_model = store.read_json(request["referenceModelRef"])
    hf = materialize(store, request["parentModel"]["hfSnapshotRef"], job_dir / "parent-hf")
    reference = materialize(store, reference_model["hfSnapshotRef"], job_dir / "reference-hf")
    if resume_ref:
        checkpoint = store.read_json(resume_ref)
        require(checkpoint["compatibilityDigest"] == compatibility_digest(request), "checkpoint-incompatible", "resume may not change runtime, reference, optimizer or model topology")
        load = materialize(store, checkpoint["actorStateRef"], job_dir / ("resume-" + resume_ref["digest"][7:]))
        start = checkpoint["committedUpdate"]
        current_hf = checkpoint["hfExportRef"]
    else:
        load = hf; current_hf = request["parentModel"]["hfSnapshotRef"]
    if pending and pending["committedUpdate"] > start:
        require(pending["committedUpdate"] == start + 1 and pending["compatibilityDigest"] == compatibility_digest(request), "invalid-pending-checkpoint", "export recovery checkpoint does not follow the last committed update")
        load = materialize(store, pending["trainerStateRef"], job_dir / ("pending-" + pending["trainerStateRef"]["digest"][7:]))
    paths = {"load": str(load), "reference": str(reference), "hf": str(hf), "save": str(job_dir / "trainer-state"), "export": str(job_dir / "exports")}
    argv = build_argv(request, store.read_json(request["trainer"]["hyperparametersRef"]), paths, parent_start)
    argv[argv.index("--start-rollout-id") + 1] = str(pending["committedUpdate"] if pending else start)
    sys.argv = ["gear-slime", *argv]
    from slime.utils.arguments import parse_args
    from slime.ray.placement_group import create_placement_groups, create_rollout_manager, create_training_models
    from slime.utils.logging_utils import configure_logger, init_tracking, finish_tracking
    import ray
    args = parse_args()
    from .recipes.agent_grpo import validate_layout
    validate_layout(args, request)
    validate_resource_args(args, request, argv)
    model_parallel = args.tensor_model_parallel_size * args.pipeline_model_parallel_size * getattr(args, "context_parallel_size", 1)
    actor_gpus = args.actor_num_nodes * args.actor_num_gpus_per_node
    require(model_parallel > 0 and actor_gpus % model_parallel == 0 and actor_gpus // model_parallel == request["trainer"]["dataParallelSize"],
            "data-parallel-drift", "actual actor TP/PP/CP topology differs from the sealed data parallel size")
    require(not args.no_save_optim and not args.no_save_rng and not args.async_save, "incomplete-checkpoint-config", "every update must synchronously save optimizer and RNG")
    # A private local Ray runtime has explicit ownership; never connect to or stop
    # the user's unrelated shared Ray cluster.
    ray.init(address="local", num_gpus=len(request["trainingDevices"]), include_dashboard=False, runtime_env={"env_vars": {"GEAR_TRAINING_JOB": str(job_dir), "PYTHONPATH": os.environ.get("PYTHONPATH", "")}})
    incarnation = "runtime_" + secrets.token_hex(16)
    manager = None
    checkpoint_ref = resume_ref
    committed = start
    outcome = "completed"
    try:
        configure_logger(); init_tracking(args)
        pgs = create_placement_groups(args)
        if pending and pending["committedUpdate"] > start:
            from .checkpoint_export import checkpoint_exporter
            with checkpoint_exporter(args, pgs, pending["committedUpdate"]) as exporter:
                checkpoint_ref, commit_ref = export_committed_actor(exporter, store, ledger, export_root=paths["export"], request=request, committed_update=start + 1,
                    trainer_directory=load, trainer_state_ref=pending["trainerStateRef"], data_cursor=pending["dataCursor"],
                    rng_state_ref=pending["trainerStateRef"], compatibility_digest=compatibility_digest(request), batch_ref=pending["batchRef"],
                    previous_commit=prior_commits[-1] if prior_commits else None)
            prior_commits.append(commit_ref); start += 1; committed = start
            current_hf = store.read_json(checkpoint_ref)["hfExportRef"]
            (job_dir / "pending-update.json").unlink()
            atomic_json(job_dir / "progress.json", {"phase": "checkpointed", "committedUpdate": committed, "latestCommitRef": commit_ref})
        remaining = request["trainer"]["updatesPerCandidate"] - len(prior_commits)
        if remaining:
            # The exporter has exited. Only actual remaining optimizer steps
            # authorize constructing the full training and rollout components.
            manager, _ = create_rollout_manager(args, pgs["rollout"])
            actor, _ = create_training_models(args, pgs, manager)
            require(hasattr(actor, "export_hf"), "missing-slime-export-extension", "apply the pinned Gear HF export patch before training")
            memory = TrainingMemoryCycle(args, ray, actor, manager)
        runtime = SlimeRoundRuntime(job_dir, request, config, store, ledger, paths, parent_start, start,
            prior_commits, checkpoint_ref, current_hf, args=args, ray=ray, memory=memory if remaining else None,
            manager=manager, incarnation=incarnation)
        if four_stage:
            _run_public_recipe(runtime)
        else:
            for rollout_id in range(start, start + remaining):
                if (job_dir / "cancel.json").exists(): outcome = "paused"; break
                runtime.prepare_round(rollout_id)
                rollout_data = ray.get(manager.generate.remote(rollout_id))
                batch = json.loads((job_dir / "batch.json").read_text())
                runtime.train_commit(rollout_id, rollout_data, batch)
        checkpoint_ref, committed = runtime.checkpoint_ref, runtime.committed
    except Exception as error:
        cause = error.as_instanceof_cause() if hasattr(error, "as_instanceof_cause") else error
        if getattr(cause, "code", None) == "no-update" or "NoUpdate" in str(error):
            outcome = "inconclusive"
        elif four_stage and getattr(cause, "code", None) == "cancelled": outcome = "paused"
        else: raise
        if "runtime" in locals(): checkpoint_ref, committed = runtime.checkpoint_ref, runtime.committed
    finally:
        if manager is not None:
            try: ray.get(manager.dispose.remote())
            finally: ray.shutdown()
        else: ray.shutdown()
        finish_tracking(args)
        ledger.close()
    finalize_candidate(job_dir, request, store, prior_commits, checkpoint_ref, outcome, committed)


if __name__ == "__main__":
    run(os.environ["GEAR_TRAINING_JOB"])
