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



def run(job_dir):
    job_dir = Path(job_dir)
    request = json.loads((job_dir / "request.json").read_text())
    config = json.loads((job_dir / "config.json").read_text())
    store, ledger = ContentStore(config["storeRoot"]), Ledger(job_dir / "ledger.sqlite")
    from .recovery import update_recovery
    recovered = update_recovery(job_dir, request, store, ledger)
    prior_commits, resume_ref, pending = recovered["commitRefs"], recovered["checkpointRef"], recovered["pending"]
    parent_start, start = recovered["parentStart"], recovered["start"]
    if len(prior_commits) == request["trainer"]["updatesPerCandidate"]:
        # SQLite already committed every update. A lost completion response
        # requires only immutable artifact publication, not CUDA or Ray startup.
        try: finalize_candidate(job_dir, request, store, prior_commits, resume_ref, "completed", start)
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
        for rollout_id in range(start, start + remaining):
            if (job_dir / "cancel.json").exists(): outcome = "paused"; break
            # Slime's initial snapshot is the parent HF, not a newer recovered
            # checkpoint. Comparing a resumed actor against it would be false.
            memory.prepare_rollout(compare_weights=args.check_weight_update_equal and rollout_id == 0)
            engines, _, _, _, _, _ = ray.get(manager.get_updatable_engines_and_lock.remote())
            versions = ray.get([engine.get_weight_version.remote() for engine in engines])
            urls = ray.get([engine.get_url.remote() for engine in engines])
            active = [(url, str(version)) for url, version in zip(urls, versions) if url is not None]
            require(active and len({v for _, v in active}) == 1, "unsynchronized-replicas", "rollout replicas disagree on current weights")
            policy = f"{incarnation}/update-{rollout_id}/weight-{active[0][1]}"
            batch_id = f"batch_{incarnation}_{rollout_id}"
            lease = create_policy_lease(request, batch_id, policy, current_hf, incarnation)
            replay = None
            prior_batch = json.loads((job_dir / "batch.json").read_text()) if (job_dir / "batch.json").exists() else None
            if prior_batch and prior_batch["rolloutId"] == rollout_id:
                sealed = store.read_json(prior_batch["batchRef"])
                source = ledger.db.execute("SELECT body,state FROM leases WHERE json_extract(body,'$.policyVersion')=?", (sealed["policyVersion"],)).fetchone()
                require(source and source["state"] == "closed" and json.loads(source["body"])["synchronizedWeightsRef"]["digest"] == current_hf["digest"],
                        "replay-pre-update-mismatch", "sealed batch replay requires its exact original pre-update actor weights")
                replay = prior_batch["batchRef"]
                batch_id = json.loads(source["body"])["batchId"]
            atomic_json(job_dir / "runtime.json", {"rolloutId": rollout_id, "lease": lease, "engineUrl": active[0][0], "weightVersion": active[0][1],
                "replicas": [{"replicaId": url, "weightsDigest": current_hf["digest"], "policyVersion": policy, "runtimeInstanceId": incarnation} for url, _ in active],
                **({"replayBatchRef": replay, "replayRuntimeInstanceId": incarnation} if replay else {})})
            atomic_json(job_dir / "progress.json", {"phase": "collecting", "committedUpdate": committed})
            rollout_data = ray.get(manager.generate.remote(rollout_id))
            batch = json.loads((job_dir / "batch.json").read_text())
            def batch_barrier():
                sealed = ledger.db.execute("SELECT ref FROM batches WHERE batch=?", (batch_id,)).fetchone()
                require(batch["rolloutId"] == rollout_id and ledger.lease(batch_id)["state"] == "closed"
                        and sealed and json.loads(sealed[0]) == batch["batchRef"],
                        "missing-batch-barrier", "optimizer and rollout offload cannot start before durable batch sealing")
            memory.finish_rollout(batch_barrier)
            atomic_json(job_dir / "progress.json", {"phase": "training", "committedUpdate": committed, "batchRef": batch["batchRef"]})
            memory.train_and_save(rollout_id, rollout_data)
            if args.rollout_global_dataset: ray.get(manager.save.remote(rollout_id))
            # Backend saves complete optimizer/scheduler/RNG in this same trainer
            # snapshot. A matching file manifest is retained by both references.
            from .export import seal_directory
            trainer_ref = seal_directory(store, paths["save"])
            data_cursor = {"committedUpdate": rollout_id + 1, "batchRef": batch["batchRef"], "groupResamples": ledger.usage()["groupResamples"]}
            if replay: data_cursor["replayOfBatch"] = replay["digest"]
            atomic_json(job_dir / "pending-update.json", {"committedUpdate": rollout_id + 1, "trainerStateRef": trainer_ref,
                "batchRef": batch["batchRef"], "dataCursor": data_cursor, "compatibilityDigest": compatibility_digest(request)})
            atomic_json(job_dir / "progress.json", {"phase": "exporting", "committedUpdate": committed, "batchRef": batch["batchRef"]})
            checkpoint_ref, commit_ref = export_committed_actor(memory, store, ledger, export_root=paths["export"], request=request, committed_update=rollout_id + 1,
                trainer_directory=paths["save"], trainer_state_ref=trainer_ref,
                data_cursor=data_cursor,
                rng_state_ref=trainer_ref, compatibility_digest=compatibility_digest(request), batch_ref=batch["batchRef"],
                previous_commit=prior_commits[-1] if prior_commits else None)
            prior_commits.append(commit_ref); committed = rollout_id + 1
            (job_dir / "pending-update.json").unlink()
            current_hf = store.read_json(checkpoint_ref)["hfExportRef"]
            atomic_json(job_dir / "progress.json", {"phase": "checkpointed", "committedUpdate": committed, "latestCommitRef": commit_ref})
            memory.complete_update()
    except Exception as error:
        cause = error.as_instanceof_cause() if hasattr(error, "as_instanceof_cause") else error
        if getattr(cause, "code", None) == "no-update" or "NoUpdate" in str(error):
            outcome = "inconclusive"
        else: raise
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
