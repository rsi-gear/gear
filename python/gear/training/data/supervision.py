"""Trusted admission of repaired captures, preference pairs and synthetic QA.

These builders consume host-verified, sealed facts. They do not authenticate a
proof supplied by an untrusted agent: artifact access and verifier authorization
remain the caller's responsibility, as for SFTDatasetBuilder. No curriculum type
or proposal can substitute for the original capture and execution evidence.
"""

from __future__ import annotations

import math
from dataclasses import asdict

from gear.training.data.builders import SFTDatasetBuilder
from gear.training.data.samples import build_capture, token_ids
from gear.training.storage.content import digest_json, require

PROTOCOLS = {"feedback_only", "verified_reference", "gold_answer_allowed"}


def _materials(proof, allowed):
    require(
        bool(allowed) and set(allowed) <= PROTOCOLS,
        "invalid-material-grant",
        "material protocols must be granted by the trusted caller",
    )
    protocols = proof.get("materialProtocols")
    require(
        isinstance(protocols, list)
        and bool(protocols)
        and all(isinstance(p, str) and p in allowed for p in protocols)
        and len(set(protocols)) == len(protocols),
        "unauthorized-supervision-material",
        "supervision material exceeds the caller's explicit grant",
    )
    return protocols


def _capture(store, raw):
    episode, feedback, context = (
        store.read_json(raw.episode_ref),
        store.read_json(raw.feedback_ref),
        store.read_json(raw.context_ref),
    )
    receipts = [store.read_json(ref) for ref in raw.receipt_refs]
    sample = build_capture(
        store,
        episode,
        receipts,
        feedback,
        context,
        assembly=store.read_json(raw.assembly_ref) if raw.assembly_ref else None,
    )
    return episode, feedback, context, receipts, sample


def _state(store, context, key):
    ref = context.get(key)
    require(isinstance(ref, dict), "missing-execution-state", key + " was not captured")
    store.read_bytes(ref)
    return ref["digest"]


def _bind(raw, proof, name):
    require(
        proof.get(name + "TrajectoryDigest") == digest_json(asdict(raw)),
        "supervision-capture-drift",
        name + " proof must bind the full immutable trajectory and context",
    )


def _sample(raw, capture):
    return {
        "tokens": capture.tokens,
        "responseLength": capture.response_length,
        "lossMask": list(capture.loss_mask),
        "sourceTrajectory": asdict(raw),
    }


class RepairSFTDatasetBuilder:
    """Keep exact tokens from a new verified execution; mask its initial calls.

    Input rows are (failed RawTrajectory, revised RawTrajectory, repair proof ref,
    success proof ref). A semantic step must be mapped to a captured call by the
    caller; lossStartReceipt is the first supervised call, not a character cut.
    """

    def __init__(self, store, *, allowed_protocols=("feedback_only",)):
        self.store, self.allowed_protocols = store, allowed_protocols

    async def build(self, repairs):
        samples, seen = [], set()
        for failed, revised, repair_ref, success_ref in repairs:
            proof = self.store.read_json(repair_ref)
            require(
                proof.get("schemaVersion") == 1
                and proof.get("kind") == "verified-repair"
                and proof.get("verified") is True
                and proof.get("failureVerified") is True,
                "invalid-repair-proof",
                "repair requires independent failure and execution verification",
            )
            _bind(failed, proof, "failed")
            _bind(revised, proof, "revised")
            protocols = _materials(proof, self.allowed_protocols)
            self.store.read_bytes(proof["evidenceRef"])
            old_e, old_f, old_c, old_r, _ = _capture(self.store, failed)
            new_e, _, new_c, new_r, new_sample = _capture(self.store, revised)
            identity = (new_e["runId"], new_e["id"])
            require(
                identity != (old_e["runId"], old_e["id"])
                and identity not in seen
                and old_e.get("termination") == "terminated"
                and old_f.get("outcome") == "valid",
                "invalid-repair-source",
                "repair needs a complete failed source and a distinct new capture",
            )
            seen.add(identity)
            require(
                all(
                    old_c[k]["digest"] == new_c[k]["digest"] for k in ("taskRef", "environmentRef")
                ),
                "repair-context-drift",
                "repair changed the task or environment",
            )
            old_requests = {(r["runId"], r["runtimeInstanceId"], r["requestId"]) for r in old_r}
            require(
                not old_requests.intersection(
                    (r["runId"], r["runtimeInstanceId"], r["requestId"]) for r in new_r
                ),
                "reused-repair-capture",
                "revised execution must not reuse the original generation receipts",
            )
            start = _state(self.store, new_c, "initialStateRef")
            require(
                proof.get("startStateDigest") == start,
                "repair-start-drift",
                "repair proof must bind the actual new initial state",
            )
            mode = proof.get("mode")
            if mode == "verified_replay":
                require(
                    start == _state(self.store, old_c, "initialStateRef"),
                    "repair-start-drift",
                    "replay must start at the original initial state",
                )
            elif mode == "terminal_continue":
                require(
                    start == _state(self.store, old_c, "finalStateRef"),
                    "repair-start-drift",
                    "continuation must start at the captured failed final state",
                )
            elif mode == "checkpoint_reset":
                checkpoints = old_c.get("checkpointStateRefs", [])
                require(
                    isinstance(checkpoints, list)
                    and any(ref.get("digest") == start for ref in checkpoints),
                    "repair-checkpoint-missing",
                    "reset target must be a checkpoint captured in the failed execution",
                )
                for ref in checkpoints:
                    self.store.read_bytes(ref)
            else:
                require(False, "invalid-repair-mode", "unsupported repair execution mode")
            success = self.store.read_json(success_ref)
            require(
                success.get("kind") == "verified-success",
                "invalid-repair-success",
                "repair requires full independently verified success",
            )
            # Reuse the canonical SFT proof and native capture checks, including
            # assembly verification for split controller/node stores.
            await SFTDatasetBuilder(self.store).build(
                [revised], verifications={new_e["id"]: success_ref}
            )
            cut = proof.get("lossStartReceipt")
            require(
                type(cut) is int and 0 <= cut < len(new_r),
                "invalid-repair-loss-boundary",
                "repair suffix must begin at a captured call boundary",
            )
            sample = _sample(revised, new_sample)
            if cut:
                prefix_end = len(self.store.read_json(new_r[cut - 1]["inputTokenIdsRef"])) + len(
                    self.store.read_json(new_r[cut - 1]["outputTokenIdsRef"])
                )
                prompt_length = len(new_sample.tokens) - new_sample.response_length
                sample["lossMask"][: prefix_end - prompt_length] = [0] * (
                    prefix_end - prompt_length
                )
            require(any(sample["lossMask"]), "empty-repair-suffix", "repair has no suffix tokens")
            sample.update(
                repairProofRef=repair_ref,
                successProofRef=success_ref,
                materialProtocols=protocols,
            )
            samples.append(sample)
        return self.store.put_json(
            {"schemaVersion": 1, "kind": "repair-sft-dataset", "samples": samples}
        )


class PreferenceDatasetBuilder:
    """Seal comparable captured pairs. This does not implement a DPO updater."""

    def __init__(self, store, *, allowed_protocols=("feedback_only",)):
        self.store, self.allowed_protocols = store, allowed_protocols

    async def build(self, pairs):
        rows, seen = [], set()
        for chosen, rejected, proof_ref in pairs:
            proof = self.store.read_json(proof_ref)
            require(
                proof.get("schemaVersion") == 1
                and proof.get("kind") == "verified-preference"
                and proof.get("verified") is True
                and proof.get("labelSource") in ("independent_verifier", "human", "majority_vote")
                and proof.get("scope") in ("trajectory", "step"),
                "invalid-preference-proof",
                "preference needs a declared comparison and label source",
            )
            _bind(chosen, proof, "chosen")
            _bind(rejected, proof, "rejected")
            protocols = _materials(proof, self.allowed_protocols)
            self.store.read_bytes(proof["evidenceRef"])
            c_e, c_f, c_c, c_r, c_s = _capture(self.store, chosen)
            r_e, r_f, r_c, r_r, r_s = _capture(self.store, rejected)
            ids = ((c_e["runId"], c_e["id"]), (r_e["runId"], r_e["id"]))
            pair_id = tuple(sorted(ids))
            require(
                ids[0] != ids[1] and pair_id not in seen,
                "duplicate-preference",
                "preference pairs need distinct captures and cannot be repeated or reversed",
            )
            seen.add(pair_id)
            requests = {(r["runId"], r["runtimeInstanceId"], r["requestId"]) for r in c_r}
            require(
                not requests.intersection(
                    (r["runId"], r["runtimeInstanceId"], r["requestId"]) for r in r_r
                ),
                "reused-preference-capture",
                "paired executions cannot relabel the same native generation requests",
            )
            require(
                all(c_c[k]["digest"] == r_c[k]["digest"] for k in ("taskRef", "environmentRef"))
                and all(c_c[k] == r_c[k] for k in ("tokenizerDigest", "chatTemplateDigest"))
                and _state(self.store, c_c, "initialStateRef")
                == _state(self.store, r_c, "initialStateRef")
                == proof.get("initialStateDigest"),
                "preference-context-drift",
                "pairs require the same task, environment, tokenizer and actual initial state",
            )
            confidence = proof.get("confidence")
            require(
                confidence is None
                or type(confidence) in (int, float)
                and math.isfinite(confidence)
                and 0 <= confidence <= 1,
                "invalid-preference-confidence",
                "confidence must be finite and within [0, 1]",
            )
            if proof["scope"] == "trajectory":
                require(
                    all(e.get("termination") == "terminated" for e in (c_e, r_e))
                    and all(f.get("outcome") == "valid" for f in (c_f, r_f)),
                    "incomplete-preference",
                    "trajectory pairs require two complete executions",
                )
                left, right = _sample(chosen, c_s), _sample(rejected, r_s)
                ci = ri = 0
            else:
                ci, ri = proof.get("chosenReceiptIndex"), proof.get("rejectedReceiptIndex")
                require(
                    type(ci) is int
                    and 0 <= ci < len(c_r)
                    and type(ri) is int
                    and 0 <= ri < len(r_r),
                    "invalid-preference-step",
                    "step selection must name an actually captured call",
                )
                states = []
                for context, index in ((c_c, ci), (r_c, ri)):
                    refs = context.get("decisionStateRefs", [])
                    require(
                        isinstance(refs, list) and index < len(refs),
                        "missing-decision-state",
                        "step comparison needs the actual decision state of each capture",
                    )
                    self.store.read_bytes(refs[index])
                    states.append(refs[index]["digest"])
                require(
                    states[0] == states[1] == proof.get("decisionStateDigest"),
                    "preference-state-drift",
                    "step pair states differ",
                )
                left, right = (
                    self._step(raw, receipts[index])
                    for raw, receipts, index in ((chosen, c_r, ci), (rejected, r_r, ri))
                )
            require(
                self.store.read_json(c_r[ci]["inputTokenIdsRef"])
                == self.store.read_json(r_r[ri]["inputTokenIdsRef"]),
                "preference-prefix-drift",
                "paired completions must have the same actual token conditioning",
            )
            require(
                left["tokens"] != right["tokens"],
                "identical-preference-completions",
                "a preference cannot distinguish identical captured completions",
            )
            rows.append(
                {
                    "chosen": left,
                    "rejected": right,
                    "proofRef": proof_ref,
                    "labelSource": proof["labelSource"],
                    "confidence": confidence,
                    "scope": proof["scope"],
                    "materialProtocols": protocols,
                }
            )
        return self.store.put_json(
            {"schemaVersion": 1, "kind": "preference-dataset", "pairs": rows}
        )

    def _step(self, raw, receipt):
        inputs = token_ids(self.store.read_json(receipt["inputTokenIdsRef"]))
        outputs = token_ids(self.store.read_json(receipt["outputTokenIdsRef"]))
        require(outputs, "empty-preference-step", "step has no captured completion")
        return {
            "tokens": inputs + outputs,
            "responseLength": len(outputs),
            "lossMask": [1] * len(outputs),
            "sourceTrajectory": asdict(raw),
            "receiptId": receipt["id"],
        }


class ProceduralDatasetBuilder:
    """Encode synthetic QA with the sealed model's real offline chat tokenizer."""

    def __init__(self, store, *, allowed_protocols=("feedback_only",)):
        self.store, self.allowed_protocols = store, allowed_protocols

    async def build(self, examples, *, model_ref, max_sequence_tokens):
        records, provenance = [], []
        for example, validation_ref in examples:
            require(
                set(example) == {"question", "answer", "source", "materialProtocol"}
                and all(
                    isinstance(example[k], str) and example[k].strip()
                    for k in ("question", "answer")
                ),
                "invalid-procedural-example",
                "synthetic QA needs question, answer, train source and material protocol",
            )
            proof = self.store.read_json(validation_ref)
            require(
                proof.get("schemaVersion") == 1
                and proof.get("kind") == "verified-procedural-example"
                and proof.get("verified") is True
                and proof.get("exampleDigest") == digest_json(example)
                and proof.get("materialProtocols") == [example["materialProtocol"]],
                "invalid-procedural-validation",
                "semantic validation must bind the exact synthetic example",
            )
            _materials(proof, self.allowed_protocols)
            self.store.read_bytes(proof["evidenceRef"])
            records.append(
                {
                    "source": example["source"],
                    "messages": [
                        {"role": "user", "content": example["question"]},
                        {"role": "assistant", "content": example["answer"]},
                    ],
                }
            )
            provenance.append({"example": example, "validationRef": validation_ref})
        from gear.training.data.offline import seal_dataset

        result = seal_dataset(
            self.store,
            {
                "schemaVersion": 1,
                "modelRef": model_ref,
                "records": records,
                "maxSequenceTokens": max_sequence_tokens,
            },
        )
        return {
            **result,
            "supervisionRef": self.store.put_json(
                {
                    "schemaVersion": 1,
                    "kind": "synthetic-procedural-supervision",
                    "datasetRef": result["datasetRef"],
                    "modelRef": model_ref,
                    "labelSource": "synthetic",
                    "examples": provenance,
                }
            ),
        }
