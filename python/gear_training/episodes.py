"""V2 durable rollout intents and controller feedback, colocated with receipts.

Only authenticated node RPC can acknowledge or resolve an intent. Generation
credentials authorize the native gateway, never this control protocol.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .content import ContentStore, ContractError, canonical, digest_bytes, digest_json, require
from .ledger import Ledger
from .state import load, lock


class EpisodeJournal:
    def __init__(self, directory, ledger=None):
        self.directory = Path(directory)
        self.ledger = ledger or Ledger(self.directory / "ledger.sqlite")
        self.owned_connection = ledger is None
        self.request = load(self.directory / "request.json")
        self.config = load(self.directory / "config.json")
        require(self.request["schemaVersion"] == 2 and self.config["schemaVersion"] == 2, "episode-protocol-version", "controller episodes require a v2 job")
        self.store = ContentStore(self.config["storeRoot"])
        self.ledger.db.executescript("""
          CREATE TABLE IF NOT EXISTS episode_intents(id TEXT PRIMARY KEY, body TEXT NOT NULL, input_digest TEXT NOT NULL,
            ack TEXT, result TEXT, consumed INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0);
        """)

    def close(self):
        if self.owned_connection: self.ledger.close()

    def publish(self, context, binding, credential, node_port):
        worker = load(self.directory / "worker.json")
        lease = self.ledger.assert_serving(context["batchId"], context["runtimeInstanceId"], binding["fencingToken"])
        registered = self.ledger.db.execute("SELECT token_hash FROM episodes WHERE id=?", (context["id"],)).fetchone()
        require(registered and registered[0] == digest_bytes(credential.encode()), "episode-credential-drift", "intent credential does not belong to this exact episode")
        require(self.store.read_json(binding["policyLeaseRef"]) == lease, "episode-lease-drift", "binding does not identify this policy lease")
        body = {"schemaVersion": 2, "id": context["id"], "jobId": self.directory.name, "incarnation": worker["incarnation"],
                "trainingRunId": self.request["trainingRunId"], "context": context, "binding": binding, "lease": lease,
                "key": digest_json([self.request["trainingRunId"], lease["batchId"], context["taskRef"]["digest"], context["groupId"], context["slot"]]),
                "gateway": {"nodePort": node_port}, "credential": credential}
        encoded, digest = canonical(body), digest_json(body)
        with self.ledger.transaction():
            old = self.ledger.db.execute("SELECT body FROM episode_intents WHERE id=?", (context["id"],)).fetchone()
            require(not old or old[0] == encoded, "episode-intent-conflict", "logical episode intent cannot change")
            self.ledger.db.execute("INSERT OR IGNORE INTO episode_intents(id,body,input_digest) VALUES(?,?,?)", (context["id"], encoded, digest))
        return {**body, "inputDigest": digest}

    def _row(self, address):
        row = self.ledger.db.execute("SELECT * FROM episode_intents WHERE id=?", (address.get("id"),)).fetchone()
        require(row, "unknown-episode-intent", "episode intent does not exist")
        intent = json.loads(row["body"])
        expected = {"id": intent["id"], "inputDigest": row["input_digest"], "jobId": intent["jobId"], "incarnation": intent["incarnation"],
                    "batchId": intent["lease"]["batchId"], "policyVersion": intent["lease"]["policyVersion"], "fencingToken": intent["lease"]["fencingToken"]}
        require(address == expected, "episode-address-drift", "episode control address differs from the job, incarnation or policy fence")
        return row, intent

    def list(self, *, renew=False, cursor=0):
        require(type(cursor) is int and cursor >= 0, "invalid-episode-cursor", "episode cursor must be a nonnegative row ID")
        if renew and not (self.directory / "cancel.json").exists():
            for row in self.ledger.db.execute("SELECT batch FROM controller_contacts").fetchall():
                if self.ledger.lease(row[0])["state"] == "serving": self.ledger.renew_controller(row[0], self.config["controllerTimeoutSeconds"])
        entries = []
        rows = self.ledger.db.execute("SELECT rowid AS cursor,* FROM episode_intents WHERE consumed=0 AND rowid>? ORDER BY rowid LIMIT 65", (cursor,)).fetchall()
        for row in rows[:64]:
            body = json.loads(row["body"]); lease = self.ledger.lease(body["lease"]["batchId"])
            contact = self.ledger.db.execute("SELECT expires FROM controller_contacts WHERE batch=?", (lease["batchId"],)).fetchone()
            cancelled = bool(row["cancel_requested"] or (self.directory / "cancel.json").exists() or lease["state"] != "serving"
                             or (contact and time.time() >= contact[0]))
            entries.append({"intent": {**body, "inputDigest": row["input_digest"]}, "cancelRequested": cancelled,
                            "ack": json.loads(row["ack"]) if row["ack"] else None, "result": json.loads(row["result"]) if row["result"] else None})
        return {"schemaVersion": 2, "jobId": self.directory.name, "entries": entries,
                "nextCursor": rows[63]["cursor"] if len(rows) > 64 else None}

    def acknowledge(self, address, ack):
        require(isinstance(ack, dict) and set(ack) == {"evalId"} and re.fullmatch(r"eval_[a-f0-9]{32}", str(ack["evalId"])), "invalid-episode-ack", "acknowledgement needs a canonical eval ID")
        with self.ledger.transaction():
            row, _ = self._row(address)
            require(not row["ack"] or row["ack"] == canonical(ack), "episode-ack-conflict", "episode acknowledgement cannot change its eval")
            require(not (row["consumed"] or row["result"]) or row["ack"], "episode-already-cancelled", "cannot submit an undispatched cancelled slot")
            self.ledger.db.execute("UPDATE episode_intents SET ack=? WHERE id=?", (canonical(ack), address["id"]))
        return {"ack": ack}

    def receipts(self, address, *, confirmed_stopped=False):
        _, intent = self._row(address)
        if confirmed_stopped:
            for row in self.ledger.db.execute("SELECT id FROM requests WHERE episode=? AND state='pending'", (intent["id"],)).fetchall():
                self.ledger.fail_request(row[0], confirmed_stopped=True)
        # Canonical terminal/cancellation is established by the controller before
        # it asks for closure. Native generation/receipt writes must also finish.
        self.ledger.finish_episode(intent["id"])
        rows = self.ledger.db.execute("SELECT state,receipt FROM requests WHERE episode=? ORDER BY call_index", (intent["id"],)).fetchall()
        return {"runId": self.ledger.context(intent["id"])["runId"], "complete": bool(rows) and all(r[0] == "complete" for r in rows),
                "receiptRefs": [json.loads(r[1]) for r in rows if r[1]]}

    def admit(self, address, result, *, confirmed_stopped=False):
        row, intent = self._row(address)
        require(result.get("schemaVersion") == 2 and result.get("outcome") == "feedback", "invalid-episode-result", "admission requires feedback")
        ack = json.loads(row["ack"]) if row["ack"] else None
        require(ack and result.get("evalId") == ack["evalId"], "episode-eval-drift", "feedback refers to another eval")
        receipts = self.receipts(address, confirmed_stopped=confirmed_stopped)
        require(receipts["complete"], "incomplete-episode", "feedback requires complete native receipts")
        feedback, episode, assembly = (self.store.read_json(result[key]) for key in ("feedbackRef", "episodeRef", "assemblyRef"))
        actual = self.ledger.context(intent["id"])
        require(feedback["runId"] == episode["runId"] == receipts["runId"] and episode["id"] == intent["id"], "episode-run-drift", "feedback and generation refer to different canonical runs")
        require(feedback["receiptIds"] == [self.store.read_json(ref)["id"] for ref in receipts["receiptRefs"]], "episode-receipt-drift", "feedback ordered receipts differ from native generation")
        from .samples import build_episode
        try:
            build_episode(self.store, episode, [self.store.read_json(ref) for ref in receipts["receiptRefs"]], feedback, actual, assembly=assembly)
        except ContractError as error:
            # Only exact-sample admission is a bounded group rejection. Missing
            # or corrupt CAS objects and control identity conflicts stay errors.
            if error.code in ("corrupt-content", "content-digest-mismatch", "invalid-ref", "invalid-digest", "invalid-content-uri", "invalid-media-type", "non-finite-json"): raise
            return {"valid": False, "reason": error.code}
        return {"valid": True}

    def resolve(self, address, result, *, confirmed_stopped=False):
        # Serialize control mutations across RPC processes. The driver consumes
        # only committed results, so a crash after add_feedback is replayable.
        with lock(self.directory / "episode-resolution.lock"):
            return self._resolve(address, result, confirmed_stopped=confirmed_stopped)

    def _resolve(self, address, result, *, confirmed_stopped=False):
        row, intent = self._row(address)
        if row["result"]:
            require(row["result"] == canonical(result), "episode-result-conflict", "episode feedback cannot change on retry")
            return {"accepted": True}
        require(isinstance(result, dict) and result.get("schemaVersion") == 2 and result.get("outcome") in ("feedback", "cancelled", "rejected"),
                "invalid-episode-result", "unknown episode resolution")
        ack = json.loads(row["ack"]) if row["ack"] else None
        require(result.get("evalId") == (ack["evalId"] if ack else None), "episode-eval-drift", "feedback refers to another eval")
        receipts = self.receipts(address, confirmed_stopped=confirmed_stopped)
        if result["outcome"] == "feedback":
            admission = self.admit(address, result, confirmed_stopped=confirmed_stopped)
            require(admission["valid"], admission.get("reason", "invalid-episode"), "exact sample failed admission")
            self.ledger.add_feedback(self.store.read_json(result["feedbackRef"]))
        else:
            require(isinstance(result.get("reason"), str) and re.fullmatch(r"[a-z][a-z0-9-]{0,127}", result["reason"]), "invalid-episode-rejection", "rejection needs a bounded reason code")
            require(ack or (receipts["runId"] is None and not receipts["receiptRefs"]), "undispatched-episode-generated", "an undispatched cancellation cannot hide native generation")
        with self.ledger.transaction():
            row, _ = self._row(address)
            require(not row["result"] or row["result"] == canonical(result), "episode-result-conflict", "concurrent feedback changed")
            self.ledger.db.execute("UPDATE episode_intents SET result=? WHERE id=?", (canonical(result), intent["id"]))
        return {"accepted": True}

    def cancel(self, intent_id):
        self.ledger.db.execute("UPDATE episode_intents SET cancel_requested=1 WHERE id=?", (intent_id,))

    def result(self, intent_id):
        row = self.ledger.db.execute("SELECT result FROM episode_intents WHERE id=?", (intent_id,)).fetchone()
        return json.loads(row[0]) if row and row[0] else None

    def consume(self, intent_id):
        with self.ledger.transaction():
            row = self.ledger.db.execute("SELECT result FROM episode_intents WHERE id=?", (intent_id,)).fetchone()
            require(row and row[0], "episode-result-pending", "cannot consume an unresolved logical slot")
            self.ledger.db.execute("UPDATE episode_intents SET consumed=1 WHERE id=?", (intent_id,))

    def reconcile_stopped(self):
        pending = self.ledger.db.execute("SELECT id FROM episode_intents WHERE result IS NULL").fetchone()
        require(not pending, "controller-episodes-pending", "controller must reconcile old Hitch slots before a new trainer incarnation")
        for row in self.ledger.db.execute("SELECT id FROM requests WHERE state='pending'").fetchall(): self.ledger.fail_request(row[0], confirmed_stopped=True)
        for row in self.ledger.db.execute("SELECT id FROM episodes WHERE state='running'").fetchall(): self.ledger.finish_episode(row[0])
        for row in self.ledger.db.execute("SELECT batch FROM leases WHERE state!='closed'").fetchall():
            self.ledger.drain(row[0]); self.ledger.close_lease(row[0])
        self.ledger.db.execute("UPDATE episode_intents SET consumed=1 WHERE result IS NOT NULL")
