"""Reconcile original Hitch submissions before fencing an abandoned incarnation."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from .content import ContentStore, atomic_json, require
from .export import dataset_destination
from .hitch import frozen_harness_ref, HitchClient
from .ledger import Ledger


async def reconcile_slots(directory, request, config):
    directory = Path(directory)
    ledger = Ledger(directory / "ledger.sqlite")
    client = HitchClient(config["hitchCommand"], config["hitchRoot"])
    try:
        active = ledger.db.execute("SELECT batch FROM leases WHERE state!='closed'").fetchall()
        if not active: return
        for row in active: ledger.drain(row[0])
        for slot in sorted((directory / "slots").glob("*/intent.json")):
            intent = json.loads(slot.read_text())
            if ledger.lease(intent["context"]["batchId"])["state"] == "closed": continue
            handle_path = slot.parent / "handle.json"
            if handle_path.exists(): eval_id = json.loads(handle_path.read_text())["evalId"]
            else:
                # Replay the *identical* durable submission, including its old
                # binding. A new runtime never revives that expired gateway.
                task_ref = intent["context"]["taskRef"]
                dataset = dataset_destination(ContentStore(config["storeRoot"]).read_json(task_ref),
                                              directory / "datasets" / task_ref["digest"][7:])
                eval_id = await client.submit(dataset=dataset,
                    harness=frozen_harness_ref(request, config),
                    binding_path=slot.parent / "binding.json", binding=intent["binding"], key=intent["key"], timeout_seconds=config["episodeTimeoutSeconds"])
                atomic_json(handle_path, {"evalId": eval_id})
            await client.cancel(eval_id)
            for _ in range(30):
                status = await client.inspect(eval_id)
                if status.get("result") and status.get("control", {}).get("state") not in ("running", "cancelling"): break
                await asyncio.sleep(1)
            else: require(False, "old-hitch-run-active", "previous canonical Hitch execution has not terminated")
        # Caller has separately proven old driver/Ray processes and GPU kernels
        # are gone. Only then can uncertain native requests be marked invalid.
        for row in ledger.db.execute("SELECT id FROM requests WHERE state='pending'").fetchall(): ledger.fail_request(row[0], confirmed_stopped=True)
        for row in ledger.db.execute("SELECT id FROM episodes WHERE state='running'").fetchall(): ledger.finish_episode(row[0])
        for row in active: ledger.close_lease(row[0])
    finally: ledger.close()


def process_identity(pid):
    import psutil
    try:
        process = psutil.Process(pid)
        return {"pid": pid, "createdAt": process.create_time()}
    except psutil.NoSuchProcess: return None


def owned_alive(identity):
    import psutil
    try:
        p = psutil.Process(identity["pid"])
        return p.create_time() == identity["createdAt"] and p.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess: return False


def stop_owned(identities):
    import psutil
    processes = []
    for identity in identities:
        try:
            process = psutil.Process(identity["pid"])
            # Check creation time on the same psutil object used for signaling.
            # Constructing a second object after owned_alive could adopt a reused
            # PID; psutil's own signal methods guard subsequent reuse of this one.
            if process.create_time() == identity["createdAt"] and process.status() != psutil.STATUS_ZOMBIE:
                processes.append(process)
        except psutil.NoSuchProcess: pass
    for p in reversed(processes):
        try: p.terminate()
        except psutil.NoSuchProcess: pass
    _, remaining = psutil.wait_procs(processes, timeout=5)
    for p in remaining:
        if any(i["pid"] == p.pid and owned_alive(i) for i in identities):
            try: p.kill()
            except psutil.NoSuchProcess: pass
    psutil.wait_procs(remaining, timeout=5)


def update_recovery(directory, request, store, ledger):
    """Resolve durable commits before loading a GPU runtime.

    pending-update is a synchronous save receipt, not another consumed marker.
    A crash after SQLite commit may leave that receipt behind. Reconcile it only
    against the identical committed snapshot; never silently ignore conflicts.
    """
    from .content import require, sync_dir, canonical
    from .state import load
    from .preflight import compatibility_digest
    directory = Path(directory)
    compatibility = compatibility_digest(request)
    parent_ref = request.get("resumeCheckpointRef")
    parent = store.read_json(parent_ref) if parent_ref else None
    if parent:
        require(parent["compatibilityDigest"] == compatibility,
                "checkpoint-incompatible", "resume may not change runtime, reference, optimizer or model topology")
    parent_start = parent["committedUpdate"] if parent else 0
    refs, commits, checkpoint = [], [], parent
    for row in ledger.db.execute("SELECT update_number,batch_digest,ref FROM commits ORDER BY update_number"):
        ref = json.loads(row["ref"]); commit = store.read_json(ref)
        expected = parent_start + len(refs) + 1
        require(row["update_number"] == expected and commit.get("committedUpdate") == expected
                and commit.get("trainingRunId") == request["trainingRunId"]
                and commit.get("consumedBatchDigest") == row["batch_digest"]
                and commit.get("previousCommitRef") == (refs[-1] if refs else None),
                "invalid-update-history", "committed updates must form this job's contiguous consumed-batch chain")
        checkpoint = store.read_json(commit["checkpointRef"])
        require(checkpoint.get("schemaVersion") == 1 and isinstance(checkpoint.get("actorStateRef"), dict)
                and isinstance(checkpoint.get("dataCursorRef"), dict) and isinstance(commit.get("rngRef"), dict)
                and checkpoint.get("committedUpdate") == expected and checkpoint.get("compatibilityDigest") == compatibility
                and checkpoint.get("actorStateRef") == checkpoint.get("optimizerStateRef") == checkpoint.get("schedulerAndRngRef")
                and checkpoint.get("dataCursorRef") == commit.get("dataCursorRef")
                and checkpoint.get("schedulerAndRngRef") == commit.get("rngRef"),
                "invalid-update-history", "committed checkpoint identity or complete trainer state differs")
        refs.append(ref); commits.append(commit)
    require(len(refs) <= request["trainer"]["updatesPerCandidate"], "invalid-update-history", "job exceeds its frozen update count")
    start = parent_start + len(refs)
    pending = load(directory / "pending-update.json")
    if pending:
        number = pending.get("committedUpdate")
        require(type(number) is int and pending.get("compatibilityDigest") == compatibility
                and pending.get("dataCursor", {}).get("committedUpdate") == number
                and pending.get("dataCursor", {}).get("batchRef") == pending.get("batchRef"),
                "invalid-pending-checkpoint", "pending checkpoint cursor, batch or compatibility differs")
        if number <= start:
            index = number - parent_start - 1
            require(0 <= index < len(commits), "invalid-pending-checkpoint", "pending checkpoint is outside this job")
            commit = commits[index]; saved = store.read_json(commit["checkpointRef"])
            require(commit["consumedBatchDigest"] == pending["batchRef"]["digest"]
                    and saved["actorStateRef"] == pending["trainerStateRef"]
                    and store.read_json(saved["dataCursorRef"]) == pending["dataCursor"],
                    "invalid-pending-checkpoint", "leftover pending receipt differs from its committed update")
            (directory / "pending-update.json").unlink(); sync_dir(directory)
            pending = None
        else:
            require(number == start + 1 and len(refs) < request["trainer"]["updatesPerCandidate"],
                    "invalid-pending-checkpoint", "export recovery checkpoint does not follow the last committed update")
            batch = ledger.db.execute("SELECT batch FROM batches WHERE ref=?", (canonical(pending["batchRef"]),)).fetchone()
            require(batch and ledger.lease(batch["batch"])["state"] == "closed",
                    "invalid-pending-checkpoint", "export recovery requires the original sealed and drained batch")
    return {"commitRefs": refs, "checkpointRef": commits[-1]["checkpointRef"] if commits else parent_ref,
            "parentStart": parent_start, "start": start, "pending": pending}
