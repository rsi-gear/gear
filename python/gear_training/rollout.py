"""Slime rollout hook with bounded whole-group admission and durable evidence."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone
from .content import ContentStore, ContractError, atomic_json, digest_bytes, digest_json, require
from .export import materialize
from .gateway import ExactGateway, NativeSGLang, slime_protocol
from .hitch import frozen_harness_ref, HitchClient, canonical_trial, validate_training_run
from .ledger import Ledger
from .recipes.agent_grpo import sampling_params, validate_layout
from .samples import EpisodeSample, build_episode, admit_group, seal_batch


class NoUpdate(ContractError):
    def __init__(self, message):
        super().__init__("no-update", message)


async def generate(args, sample, sampling_params):
    """Official per-episode hook. The outer wrapper supplies the frozen executor."""
    executor = getattr(args, "gear_episode_executor", None)
    require(executor is not None, "missing-batch-controller", "exact episode hook requires Gear's group wrapper")
    episode_sample = await executor(sample.metadata["gearContext"])
    return episode_sample.into_slime(sample)


async def collect_rollout(args, rollout_id, job_dir):
    from aiohttp import web
    from transformers import AutoTokenizer
    job_dir = Path(job_dir)
    runtime = json.loads((job_dir / "runtime.json").read_text())
    request = json.loads((job_dir / "request.json").read_text())
    config = json.loads((job_dir / "config.json").read_text())
    validate_layout(args, request)
    require(runtime["rolloutId"] == rollout_id, "runtime-cursor-mismatch", "Slime rollout does not match synchronized actor cursor")
    store, ledger = ContentStore(config["storeRoot"]), Ledger(job_dir / "ledger.sqlite")
    v2 = request["schemaVersion"] == 2
    client = None if v2 else HitchClient(config["hitchCommand"], config["hitchRoot"])
    if client: await client.capabilities()
    sampling = sampling_params(request["rollout"])
    parent = request["parentModel"]
    lease = runtime["lease"]
    require(lease["samplingDigest"] == digest_json(sampling), "sampling-policy-drift", "policy lease must identify the exact native sampling parameters")
    ledger.open_lease(lease, runtime["replicas"])
    tokenizer = AutoTokenizer.from_pretrained(args.hf_checkpoint, trust_remote_code=False, local_files_only=True)
    render, parse = slime_protocol(tokenizer, config.get("toolParser"), config.get("reasoningParser"))
    native = NativeSGLang(runtime["engineUrl"], runtime["weightVersion"])
    gateway = ExactGateway(store, ledger, native, lease["runtimeInstanceId"], parent["tokenizerDigest"], parent["chatTemplateDigest"], render, parse)
    runner = web.AppRunner(gateway.application()); await runner.setup()
    site = web.TCPSite(runner, config["gatewayBindHost"], config["gatewayPort"] if v2 else 0); await site.start()
    port = site._server.sockets[0].getsockname()[1]
    endpoint = None if v2 else f"http://{config['gatewayAdvertisedHost']}:{port}"
    journal = None
    if v2:
        from .episodes import EpisodeJournal
        journal = EpisodeJournal(job_dir, ledger)
        ledger.require_controller(lease["batchId"], config["controllerTimeoutSeconds"])
    groups, evidence, active_evals = [], [], set()
    budget = request["budgets"]
    deadline = time.monotonic() + budget["totalGpuSeconds"] / len(request["trainingDevices"])
    last_error = None

    async def controller_episode(context, binding, credential):
        journal.publish(context, binding, credential, port)
        try:
            while True:
                result = journal.result(context["id"])
                if result:
                    try:
                        if result["outcome"] != "feedback": raise ContractError(result["reason"], "controller rejected or cancelled the canonical episode")
                        context = ledger.context(context["id"])
                        receipts = ledger.receipts(context["id"])
                        episode, feedback, assembly = (store.read_json(result[key]) for key in ("episodeRef", "feedbackRef", "assemblyRef"))
                        sample = build_episode(store, episode, [store.read_json(ref) for ref in receipts], feedback, context, assembly=assembly)
                        evidence.extend([result["episodeRef"], result["feedbackRef"], result["assemblyRef"], *receipts])
                        return sample
                    finally: journal.consume(context["id"])
                if (job_dir / "cancel.json").exists(): raise ContractError("cancelled", "training pause requested")
                if time.monotonic() >= deadline: raise NoUpdate("GPU budget ended controller episode collection")
                ledger.assert_serving(lease["batchId"], lease["runtimeInstanceId"], lease["fencingToken"])
                await asyncio.sleep(0.2)
        except BaseException:
            journal.cancel(context["id"])
            raise

    async def episode(context):
        nonlocal last_error
        if (job_dir / "cancel.json").exists():
            raise ContractError("cancelled", "training pause requested")
        credential = secrets.token_hex(32)
        ledger.register_episode(context, digest_bytes(credential.encode()))
        binding = {"kind": "training-external", "bindingId": context["bindingId"], "trainingRunId": request["trainingRunId"],
                   "policyLeaseRef": store.put_json(lease), "expectedPolicyVersion": lease["policyVersion"], "fencingToken": lease["fencingToken"],
                   "expiresAt": lease["expiresAt"], "endpointRef": "hitch-training:" + context["bindingId"], "credentialRef": "hitch-training:" + context["bindingId"],
                   "generationContractDigest": context["generationContractDigest"], "requiredCapture": "exact-policy-tokens-v1", "api": "chat-completions",
                   "maxOutputTokens": sampling["max_new_tokens"], "maxEpisodeSteps": budget["maxEpisodeSteps"]}
        slot_dir = job_dir / "slots" / context["id"]
        atomic_json(slot_dir / "binding.json", binding)
        key = digest_json([request["trainingRunId"], lease["batchId"], context["taskRef"]["digest"], context["groupId"], context["slot"]])
        # Saving the full intent before submit allows an uncertain response to be
        # reconciled with exactly this idempotency key, never a replacement slot.
        atomic_json(slot_dir / "intent.json", {"key": key, "context": context, "binding": binding})
        if v2: return await controller_episode(context, binding, credential)
        await client.register(binding, endpoint, credential)
        from .export import dataset_destination
        destination = dataset_destination(store.read_json(context["taskRef"]), job_dir / "datasets" / context["taskRef"]["digest"][7:])
        dataset = materialize(store, context["taskRef"], destination)
        eval_id = await client.submit(dataset=dataset, harness=frozen_harness_ref(request, config),
                                      binding_path=slot_dir / "binding.json", binding=binding, key=key, timeout_seconds=config["episodeTimeoutSeconds"])
        atomic_json(slot_dir / "handle.json", {"evalId": eval_id}); active_evals.add(eval_id)
        try:
            while True:
                if time.monotonic() >= deadline or (job_dir / "cancel.json").exists():
                    raise NoUpdate("GPU budget or cancellation ended rollout collection")
                inspection = await client.inspect(eval_id)
                trial = canonical_trial(inspection, binding)
                if trial is not None:
                    break
                await asyncio.sleep(1)
            context = ledger.context(context["id"])
            require(context["runId"] == trial["run_id"], "hitch-canonical-run-mismatch", "verifier and generation used different physical runs")
            # Gateway requests must be finished before closing an episode.
            ledger.finish_episode(context["id"])
            receipt_refs = ledger.receipts(context["id"])
            receipts = [store.read_json(r) for r in receipt_refs]
            verifier = await client.verifier(trial["run_id"])
            record = validate_training_run(store, await client.run_record(trial["run_id"]), context, eval_id,
                frozen_harness_ref(request, config))
            terminal = await client.training_evidence(trial["run_id"])
            require(terminal.get("training_external", {}).get("policy_version") == lease["policyVersion"], "hitch-policy-mismatch", "run evidence lost its actual training policy")
            verifier_ref = store.put_json(verifier)
            feedback = {"schemaVersion": 1, "id": "feedback_" + secrets.token_hex(16), "episodeId": context["id"], "runId": trial["run_id"],
                        "receiptIds": [r["id"] for r in receipts], "verifierVersion": request["verifier"]["digest"], "verifierEvidenceRef": verifier_ref,
                        "outcome": "valid" if trial.get("observation_status") == "valid" and record.get("observation", {}).get("status") == "valid"
                            and record["observation"].get("reward") == trial.get("reward") and verifier.get("verifier", {}).get("status") == "complete" else "invalid"}
            if feedback["outcome"] == "valid": feedback["reward"] = trial.get("reward")
            ep = {"schemaVersion": 1, "id": context["id"], "groupId": context["groupId"], "slot": context["slot"], "harnessRef": context["harnessRef"],
                  "taskRef": context["taskRef"], "environmentRef": context["environmentRef"], "policyVersion": lease["policyVersion"], "runId": trial["run_id"],
                  "receiptIds": feedback["receiptIds"], "feedbackId": feedback["id"],
                  "termination": terminal.get("termination", "infra-error"),
                  "eligibility": "eligible", "rejectionReasons": []}
            ledger.add_feedback(feedback)
            evidence.extend([store.put_json(inspection), store.put_json(ep), store.put_json(feedback), *receipt_refs])
            return build_episode(store, ep, receipts, feedback, context)
        finally:
            # Terminal evals keep canonical results; cancellation is idempotent.
            await client.cancel(eval_id)
            for _ in range(30):
                stopped = await client.inspect(eval_id)
                if stopped.get("result") and stopped.get("control", {}).get("state") not in ("running", "cancelling"):
                    break
                await asyncio.sleep(1)
            else:
                raise ContractError("hitch-cancellation-pending", "canonical Hitch execution has not terminated")
            active_evals.discard(eval_id)
            try: ledger.finish_episode(context["id"])
            except ContractError: pass

    try:
        attempt = 0
        # The committed update cursor also determines the next task window.
        # Restarting at task zero would starve the dataset suffix whenever B is
        # smaller than the task count. Recovery keeps rollout_id unchanged, and
        # sealed replay bypasses collection entirely.
        task_start = rollout_id * request["trainer"]["rolloutBatchSize"]
        while len(groups) < request["trainer"]["rolloutBatchSize"]:
            usage = ledger.usage()
            if time.monotonic() >= deadline or usage["rolloutTokens"] >= budget["maxRolloutTokens"] or usage["groupResamples"] > budget["maxGroupResamples"]:
                raise NoUpdate("budget cannot supply B complete GRPO groups; last rejection: " + str(last_error))
            task = request["trainDataset"]["tasks"][(task_start + attempt) % len(request["trainDataset"]["tasks"])]
            group_id = lease["batchId"] + "-group-" + str(attempt)
            attempt += 1
            samples = []
            try:
                for slot in range(request["rollout"]["groupSize"]):
                    episode_id = group_id + "-" + str(slot)
                    context = {"id": episode_id, "trainingRunId": request["trainingRunId"], "batchId": lease["batchId"], "bindingId": "binding_" + digest_json(episode_id)[7:39],
                               "groupId": group_id, "slot": slot, "runId": None, "taskId": task["id"], "logicalAttempt": 1,
                               "harnessRef": request["fixedHarness"]["manifestRef"], "taskRef": task["taskRef"], "environmentRef": task["environmentRef"],
                               "policyVersion": lease["policyVersion"], "wireModel": lease["policyVersion"], "runtimeInstanceId": lease["runtimeInstanceId"],
                               "tokenizerDigest": parent["tokenizerDigest"], "chatTemplateDigest": parent["chatTemplateDigest"], "sampling": sampling,
                               "maxRolloutTokens": budget["maxRolloutTokens"], "maxContextTokens": request["rollout"]["sampling"]["maxContextTokens"], "maxEpisodeSteps": budget["maxEpisodeSteps"],
                               "generationContractDigest": request["trainer"]["runtimeLock"]["protocolDigest"], "verifierVersion": request["verifier"]["digest"]}
                    samples.append(await episode(context))
                groups.append(admit_group(samples, request["rollout"]["groupSize"], request["rollout"]["zeroVarianceGroup"]))
            except ContractError as error:
                last_error = error.code
                atomic_json(job_dir / "rejections" / (group_id + ".json"), {"groupId": group_id, "reason": error.code, "detail": str(error)})
                if error.code in ("cancelled", "controller-contact-expired", "lease-fenced", "lease-expired"): raise
                if ledger.usage()["groupResamples"] >= budget["maxGroupResamples"]:
                    raise NoUpdate("bounded group resampling exhausted: " + error.code)
                ledger.charge("resample/" + group_id, resamples=1)
        ledger.drain(lease["batchId"])
        closed = ledger.close_lease(lease["batchId"])
        batch_ref = seal_batch(store, groups, request, closed, evidence)
        ledger.seal(lease["batchId"], batch_ref)
        atomic_json(job_dir / "batch.json", {"rolloutId": rollout_id, "batchRef": batch_ref})
        return groups, ledger.usage()
    finally:
        ledger.drain(lease["batchId"])
        for eval_id in active_evals: await client.cancel(eval_id)
        await runner.cleanup()
        # Pending native requests deliberately prevent a false quiescence claim.
        try: ledger.close_lease(lease["batchId"])
        except ContractError: pass
        ledger.close()


def generate_rollout(args, rollout_id, data_source, evaluation=False):
    require(not evaluation, "evaluation-isolation", "held-out and dev evaluation belong to Gear/Hitch, not the trainer")
    job_dir = os.environ.get("GEAR_TRAINING_JOB")
    require(job_dir, "missing-job-context", "GEAR_TRAINING_JOB must identify a frozen training request")
    runtime = json.loads((Path(job_dir) / "runtime.json").read_text())
    if runtime.get("replayBatchRef"):
        config = json.loads((Path(job_dir) / "config.json").read_text())
        request = json.loads((Path(job_dir) / "request.json").read_text())
        validate_layout(args, request)
        store = ContentStore(config["storeRoot"])
        batch = store.read_json(runtime["replayBatchRef"])
        require(batch["trainingRunId"] == request["trainingRunId"] and batch["recipeDigest"] == request["recipeDigest"]
                and batch["datasetSplitDigest"] == request["datasetSplitDigest"], "invalid-replay-batch", "replay must retain the original frozen batch identity")
        groups = [[EpisodeSample(**sample) for sample in group] for group in store.read_json(batch["samplesRef"])]
        require(len(groups) == request["trainer"]["rolloutBatchSize"], "invalid-replay-layout", "replay requires B complete groups")
        for group in groups:
            admit_group(group, request["rollout"]["groupSize"], request["rollout"]["zeroVarianceGroup"])
            require(all(s.metadata["policyVersion"] == batch["policyVersion"] for s in group), "replay-policy-mismatch", "replay may not relabel behavior receipts")
        ledger = Ledger(Path(job_dir) / "ledger.sqlite"); usage = ledger.usage(); ledger.close()
    else:
        groups, usage = asyncio.run(collect_rollout(args, rollout_id, job_dir))
    from slime.rollout.base_types import RolloutFnTrainOutput
    result = []
    index = 0
    for group_index, group in enumerate(groups):
        converted = []
        for item in group:
            sample = item.into_slime()
            sample.index = index; sample.rollout_id = rollout_id * sum(len(g) for g in groups) + index; sample.group_index = group_index
            converted.append(sample); index += 1
        result.append(converted)
    return RolloutFnTrainOutput(samples=result, metrics={"gear/rollout_tokens": usage["rolloutTokens"], "gear/group_resamples": usage["groupResamples"]})
