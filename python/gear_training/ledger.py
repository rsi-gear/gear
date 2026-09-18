"""Durable logical slots and fencing. SQLite owns transitions; CAS owns facts."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from .content import canonical, digest_json, require


class Ledger:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS leases(batch TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, batch TEXT NOT NULL, slot_key TEXT UNIQUE NOT NULL,
            body TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, episode TEXT NOT NULL, call_index INTEGER NOT NULL,
            request_digest TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, UNIQUE(episode, call_index));
          CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, episode TEXT NOT NULL, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS batches(batch TEXT PRIMARY KEY, ref TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commits(update_number INTEGER PRIMARY KEY, batch_digest TEXT UNIQUE NOT NULL, ref TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, tokens INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, gpu_seconds REAL NOT NULL, tokens INTEGER NOT NULL, resamples INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS controller_contacts(batch TEXT PRIMARY KEY, expires REAL NOT NULL);
        """)

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def open_lease(self, lease, replicas):
        require(lease["state"] == "serving" and replicas, "unsynchronized-policy", "every participating engine needs synchronization evidence")
        require(all(r.get("weightsDigest") == lease["synchronizedWeightsRef"]["digest"] and r.get("runtimeInstanceId") == lease["runtimeInstanceId"]
                    and r.get("policyVersion") == lease["policyVersion"] for r in replicas), "unsynchronized-policy", "replica synchronization identity differs")
        require(len({r["replicaId"] for r in replicas}) == len(replicas), "duplicate-replica", "replica acknowledgments must be unique")
        with self.transaction():
            old = self.db.execute("SELECT body,state FROM leases WHERE batch=?", (lease["batchId"],)).fetchone()
            if old:
                require(old["body"] == canonical(lease) and old["state"] == "serving", "lease-reuse", "closed or different lease cannot be reopened")
                return
            active = self.db.execute("SELECT batch FROM leases WHERE state!='closed'").fetchone()
            require(not active, "policy-already-serving", "synchronous v1 permits only one active batch")
            self.db.execute("INSERT INTO leases VALUES(?,?,?)", (lease["batchId"], canonical(lease), "serving"))

    def lease(self, batch):
        row = self.db.execute("SELECT * FROM leases WHERE batch=?", (batch,)).fetchone()
        require(row, "unknown-lease", "batch lease does not exist")
        return {**json.loads(row["body"]), "state": row["state"]}

    def assert_serving(self, batch, runtime=None, fencing=None):
        lease = self.lease(batch)
        require(lease["state"] == "serving", "lease-fenced", "batch is draining or closed")
        expires = datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00")).timestamp()
        require(time.time() < expires, "lease-expired", "policy lease expired")
        contact = self.db.execute("SELECT expires FROM controller_contacts WHERE batch=?", (batch,)).fetchone()
        require(not contact or time.time() < contact[0], "controller-contact-expired", "controller contact expired; do not issue new generation")
        require(runtime is None or runtime == lease["runtimeInstanceId"], "runtime-fenced", "old runtime incarnation cannot generate")
        require(fencing is None or fencing == lease["fencingToken"], "lease-fenced", "fencing token differs")
        return lease

    def require_controller(self, batch, timeout):
        require(type(timeout) is int and 10 <= timeout <= 300, "invalid-controller-timeout", "controller timeout must be 10..300 seconds")
        with self.transaction():
            self.assert_serving(batch)
            self.db.execute("INSERT OR IGNORE INTO controller_contacts VALUES(?,?)", (batch, time.time() + timeout))

    def renew_controller(self, batch, timeout):
        with self.transaction():
            row = self.db.execute("SELECT expires FROM controller_contacts WHERE batch=?", (batch,)).fetchone()
            require(row, "missing-controller-contact", "batch did not register controller ownership")
            if row[0] <= time.time():
                self.db.execute("UPDATE leases SET state='draining' WHERE batch=? AND state='serving'", (batch,))
                return False
            self.db.execute("UPDATE controller_contacts SET expires=? WHERE batch=?", (time.time() + timeout, batch))
        return True

    def register_episode(self, context, token_hash):
        key = canonical([context["trainingRunId"], context["batchId"], context["taskRef"]["digest"], context["groupId"], context["slot"]])
        with self.transaction():
            lease = self.assert_serving(context["batchId"], context["runtimeInstanceId"])
            require(context["policyVersion"] == lease["policyVersion"], "policy-mismatch", "episode must use this frozen policy")
            existing = self.db.execute("SELECT body,token_hash FROM episodes WHERE slot_key=?", (key,)).fetchone()
            if existing:
                require(existing["body"] == canonical(context) and existing["token_hash"] == token_hash, "slot-already-assigned", "retry cannot replace an assigned logical slot")
                return
            self.db.execute("INSERT INTO episodes VALUES(?,?,?,?,?,?)", (context["id"], context["batchId"], key, canonical(context), token_hash, "running"))

    def authorize(self, token_hash, runtime):
        row = self.db.execute("SELECT * FROM episodes WHERE token_hash=?", (token_hash,)).fetchone()
        require(row and row["state"] == "running", "invalid-run-credential", "credential is not authorized for an active episode")
        context = json.loads(row["body"])
        self.assert_serving(context["batchId"], runtime)
        return context

    def bind_run(self, token_hash, runtime, run_id, binding_id):
        import re
        require(isinstance(run_id, str) and re.fullmatch(r"run_[a-f0-9]{32}", run_id), "invalid-run-id", "expected canonical Hitch run ID")
        with self.transaction():
            context = self.authorize(token_hash, runtime)
            require(context.get("bindingId") == binding_id and context.get("runId") in (None, run_id), "run-binding-conflict", "episode is already bound to a different canonical run")
            context["runId"] = run_id
            self.db.execute("UPDATE episodes SET body=? WHERE id=?", (canonical(context), context["id"]))
        return context

    def generation_history(self, episode_id):
        """Allow the empty first turn; preserve incomplete rows as barriers."""
        rows = self.db.execute("SELECT state,receipt FROM requests WHERE episode=? ORDER BY call_index", (episode_id,)).fetchall()
        return [json.loads(row["receipt"]) if row["state"] == "complete" else None for row in rows]

    def context(self, episode_id):
        row = self.db.execute("SELECT body FROM episodes WHERE id=?", (episode_id,)).fetchone()
        require(row, "unknown-episode", "episode was not assigned")
        return json.loads(row[0])

    def begin_request(self, context, request_id, request_digest, max_tokens=None):
        with self.transaction():
            self.assert_serving(context["batchId"], context["runtimeInstanceId"])
            ep = self.db.execute("SELECT state FROM episodes WHERE id=?", (context["id"],)).fetchone()
            require(ep and ep["state"] == "running", "episode-closed", "episode no longer accepts requests")
            old = self.db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if old:
                require(old["episode"] == context["id"] and old["request_digest"] == request_digest, "request-retry-conflict", "idempotency key was reused for another request")
                require(old["state"] == "complete", "request-inflight", "request is pending or invalid; do not regenerate it")
                return old["call_index"], json.loads(old["receipt"])
            pending = self.db.execute("SELECT id FROM requests WHERE episode=? AND state='pending'", (context["id"],)).fetchone()
            require(not pending, "parallel-call-rejected", "v1 linear episodes cannot fork requests")
            index = self.db.execute("SELECT COUNT(*) FROM requests WHERE episode=?", (context["id"],)).fetchone()[0]
            require(index < context["maxEpisodeSteps"], "episode-step-budget", "episode exhausted its model-call budget")
            if max_tokens is not None:
                require(type(max_tokens) is int and max_tokens > 0 and type(context.get("maxRolloutTokens")) is int,
                        "invalid-token-reservation", "generation requires the remaining rollout token budget")
                reserved = self.db.execute("SELECT COALESCE(SUM(tokens),0) FROM reservations").fetchone()[0]
                require(self.usage()["rolloutTokens"] + reserved + max_tokens <= context["maxRolloutTokens"],
                        "rollout-token-budget", "output reservation exceeds the rollout token budget")
                self.db.execute("INSERT INTO reservations VALUES(?,?)", (request_id, max_tokens))
            self.db.execute("INSERT INTO requests VALUES(?,?,?,?,?,NULL)", (request_id, context["id"], index, request_digest, "pending"))
            return index, None

    def complete_request(self, request_id, receipt_ref):
        with self.transaction():
            row = self.db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            require(row and (row["state"] == "pending" or row["receipt"] == canonical(receipt_ref)), "receipt-conflict", "completed receipt is immutable")
            self.db.execute("UPDATE requests SET state='complete',receipt=? WHERE id=?", (canonical(receipt_ref), request_id))
            self.db.execute("DELETE FROM reservations WHERE id=?", (request_id,))

    def fail_request(self, request_id, confirmed_stopped=False):
        # An uncertain native generation remains pending and blocks the barrier.
        if confirmed_stopped:
            with self.transaction():
                reserved = self.db.execute("SELECT tokens FROM reservations WHERE id=?", (request_id,)).fetchone()
                if reserved:
                    # Unknown/malformed output consumes the full reservation conservatively.
                    self.db.execute("INSERT OR IGNORE INTO usage VALUES(?,0,?,0)", ("generation/" + request_id, reserved[0]))
                    self.db.execute("DELETE FROM reservations WHERE id=?", (request_id,))
                self.db.execute("UPDATE requests SET state='invalid' WHERE id=? AND state='pending'", (request_id,))

    def finish_episode(self, episode_id):
        with self.transaction():
            pending = self.db.execute("SELECT id FROM requests WHERE episode=? AND state='pending'", (episode_id,)).fetchone()
            require(not pending, "generation-still-running", "native generation or receipt write has not finished")
            self.db.execute("UPDATE episodes SET state='finished' WHERE id=?", (episode_id,))

    def receipts(self, episode_id):
        rows = self.db.execute("SELECT * FROM requests WHERE episode=? ORDER BY call_index", (episode_id,)).fetchall()
        require(rows and all(r["state"] == "complete" for r in rows), "incomplete-receipts", "episode contains missing or aborted generation evidence")
        return [json.loads(r["receipt"]) for r in rows]

    def add_feedback(self, feedback):
        with self.transaction():
            ep = self.db.execute("SELECT * FROM episodes WHERE id=?", (feedback["episodeId"],)).fetchone()
            require(ep and not self.db.execute("SELECT batch FROM batches WHERE batch=?", (ep["batch"],)).fetchone(), "feedback-after-seal", "sealed feedback cannot be revised")
            old = self.db.execute("SELECT body FROM feedback WHERE id=?", (feedback["id"],)).fetchone()
            if old:
                require(old["body"] == canonical(feedback), "feedback-id-conflict", "feedback retry changed its body")
                return
            if feedback.get("supersedes"):
                prev = self.db.execute("SELECT episode FROM feedback WHERE id=?", (feedback["supersedes"],)).fetchone()
                require(prev and prev["episode"] == feedback["episodeId"], "invalid-feedback-revision", "feedback revision must refer to the same episode")
            self.db.execute("INSERT INTO feedback VALUES(?,?,?)", (feedback["id"], feedback["episodeId"], canonical(feedback)))

    def drain(self, batch):
        with self.transaction():
            self.lease(batch)
            self.db.execute("UPDATE leases SET state='draining' WHERE batch=? AND state='serving'", (batch,))

    def close_lease(self, batch):
        with self.transaction():
            lease = self.lease(batch)
            require(lease["state"] in ("draining", "closed"), "lease-not-draining", "close requires a drain barrier")
            pending = self.db.execute("SELECT r.id FROM requests r JOIN episodes e ON e.id=r.episode WHERE e.batch=? AND r.state='pending'", (batch,)).fetchone()
            running = self.db.execute("SELECT id FROM episodes WHERE batch=? AND state='running'", (batch,)).fetchone()
            require(not pending and not running, "batch-not-quiescent", "Hitch runs, native requests and receipt writes must all terminate")
            self.db.execute("UPDATE leases SET state='closed' WHERE batch=?", (batch,))
        return self.lease(batch)

    def seal(self, batch, ref):
        with self.transaction():
            require(self.lease(batch)["state"] == "closed", "lease-not-closed", "seal only after closing the policy lease")
            old = self.db.execute("SELECT ref FROM batches WHERE batch=?", (batch,)).fetchone()
            require(not old or old["ref"] == canonical(ref), "batch-already-sealed", "a sealed batch cannot be replaced")
            self.db.execute("INSERT OR IGNORE INTO batches VALUES(?,?)", (batch, canonical(ref)))

    def commit_update(self, update, batch_digest, ref):
        with self.transaction():
            old = self.db.execute("SELECT * FROM commits WHERE update_number=?", (update,)).fetchone()
            if old:
                require(old["batch_digest"] == batch_digest and old["ref"] == canonical(ref), "update-conflict", "a committed update cannot be replaced")
                return
            last = self.db.execute("SELECT MAX(update_number) FROM commits").fetchone()[0]
            require(last is None or update == last + 1, "update-gap", "update commits must be contiguous")
            self.db.execute("INSERT INTO commits VALUES(?,?,?)", (update, batch_digest, canonical(ref)))

    def charge(self, event_id, gpu_seconds=0, tokens=0, resamples=0):
        require(gpu_seconds >= 0 and tokens >= 0 and resamples >= 0, "negative-usage", "budget usage cannot go backwards")
        with self.transaction():
            old = self.db.execute("SELECT * FROM usage WHERE id=?", (event_id,)).fetchone()
            if old:
                require((old["gpu_seconds"], old["tokens"], old["resamples"]) == (gpu_seconds, tokens, resamples), "usage-conflict", "usage event identity was reused")
            else:
                self.db.execute("INSERT INTO usage VALUES(?,?,?,?)", (event_id, gpu_seconds, tokens, resamples))

    def usage(self):
        row = self.db.execute("SELECT COALESCE(SUM(gpu_seconds),0),COALESCE(SUM(tokens),0),COALESCE(SUM(resamples),0) FROM usage").fetchone()
        return {"gpuSeconds": row[0], "rolloutTokens": row[1], "groupResamples": row[2]}
