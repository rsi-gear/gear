"""Strict admission of linear on-policy episodes. No decode/re-encode path."""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from .content import ContractError, require, digest_json


@dataclass
class EpisodeSample:
    tokens: list
    response_length: int
    loss_mask: list
    rollout_log_probs: list
    reward: float
    metadata: dict

    def into_slime(self, sample=None):
        from slime.utils.types import Sample
        result = sample if sample is not None else Sample()
        result.tokens = list(self.tokens)
        result.response_length = self.response_length
        result.loss_mask = list(self.loss_mask)
        result.rollout_log_probs = list(self.rollout_log_probs)
        result.reward = self.reward
        result.status = Sample.Status.COMPLETED
        result.weight_versions = [self.metadata["policyVersion"]]
        result.metadata = {**(result.metadata or {}), **self.metadata}
        result.remove_sample = False
        return result


def token_ids(value):
    require(isinstance(value, list) and all(type(x) is int and 0 <= x <= 2147483647 for x in value), "invalid-token-ids", "exact token IDs must be nonnegative int32 values")
    return value


def build_episode(store, episode, receipts, feedback, context, *, assembly=None):
    """context is a frozen per-slot assignment, not facts supplied by the agent."""
    require(episode.get("schemaVersion") == feedback.get("schemaVersion") == 1, "invalid-schema", "unsupported training schema")
    require(episode.get("termination") == "terminated", "episode-" + str(episode.get("termination")), "only normally terminated episodes are eligible")
    require(episode.get("eligibility") == "eligible" and not episode.get("rejectionReasons"), "episode-ineligible", "Hitch episode is ineligible")
    for key in ("id", "groupId", "slot", "runId", "policyVersion"):
        require(episode.get(key) == context.get(key), "episode-identity-mismatch", "episode differs from its logical slot: " + key)
    for key in ("harnessRef", "taskRef", "environmentRef"):
        require(episode[key]["digest"] == context[key]["digest"], "episode-assembly-drift", key + " changed")
        if assembly is None: store.read_bytes(episode[key])
    if assembly is not None:
        expected = {"schemaVersion": 2, "kind": "controller-episode-verification", "episodeId": episode["id"], "runId": episode["runId"],
                    "taskDigest": context["taskRef"]["digest"], "environmentDigest": context["environmentRef"]["digest"],
                    "harnessDigest": context["harnessRef"]["digest"], "verifierVersion": context["verifierVersion"], "feedbackDigest": digest_json(feedback)}
        require(assembly == expected, "controller-assembly-drift", "controller verification does not bind this exact task, environment, harness and feedback")
    require(feedback.get("id") == episode.get("feedbackId") and feedback.get("episodeId") == episode["id"] and feedback.get("runId") == episode["runId"],
            "feedback-join-mismatch", "feedback must join to this exact run and episode")
    reward = feedback.get("reward")
    require(feedback.get("outcome") == "valid" and type(reward) in (int, float) and math.isfinite(reward), "invalid-verifier", "verifier must return a finite valid reward; valid zero is retained")
    require(feedback.get("verifierVersion") == context["verifierVersion"], "verifier-drift", "verifier changed")
    store.read_bytes(feedback["verifierEvidenceRef"])
    require(isinstance(receipts, list) and receipts, "missing-receipts", "HTTP capture or empty receipts cannot train")
    ids = [r["id"] for r in receipts]
    require(len(set(ids)) == len(ids) and ids == episode["receiptIds"] and ids == feedback["receiptIds"], "receipt-join-mismatch", "ordered receipts must match episode and verifier feedback exactly")
    require(len(receipts) <= context["maxEpisodeSteps"], "episode-step-budget", "episode exceeded the sealed step limit")
    sequence, mask, logprobs, requests = [], [], [], set()
    prompt_length = None
    for index, r in enumerate(receipts):
        require(r.get("schemaVersion") == 1 and r.get("complete") is True, "incomplete-receipt", "generation terminal evidence is missing")
        for key in ("runId", "policyVersion", "runtimeInstanceId", "tokenizerDigest", "chatTemplateDigest", "taskId", "logicalAttempt"):
            require(r.get(key) == context.get(key), "generation-identity-mismatch", "receipt has wrong " + key)
        require(r.get("episodeId") == episode["id"] and r.get("callIndex") == index, "nonlinear-call-order", "call order must be complete and linear")
        require(r.get("requestId") and r["requestId"] not in requests, "duplicate-request", "a retried request cannot create another gradient sample")
        requests.add(r["requestId"])
        require(r.get("finishReason") in ("stop", "tool-call"), "generation-" + str(r.get("finishReason")), "truncated or failed generation is ineligible")
        effective = store.read_json(r["effectiveSamplingRef"])
        expected = context["sampling"]
        for key in ("temperature", "top_p", "top_k", "repetition_penalty"):
            require(effective.get(key) == expected[key], "sampling-drift", "effective sampling conflicts with the recipe")
        require(type(effective.get("max_new_tokens")) is int and 0 < effective["max_new_tokens"] <= expected["max_new_tokens"], "sampling-budget-drift", "generation output budget was widened")
        inputs = token_ids(store.read_json(r["inputTokenIdsRef"]))
        outputs = token_ids(store.read_json(r["outputTokenIdsRef"]))
        probs = store.read_json(r["behaviorLogProbsRef"])
        require(isinstance(probs, list) and len(outputs) == len(probs) and all(type(p) in (int, float) and math.isfinite(p) and p <= 0 for p in probs), "logprob-misaligned", "every generated token requires its finite behavior logprob")
        require(inputs and len(inputs) + len(outputs) <= context["maxContextTokens"], "context-budget", "actual generation exceeds its context limit")
        store.read_bytes(r["rawRequestRef"]); store.read_bytes(r["rawResponseRef"])
        if prompt_length is None:
            sequence = list(inputs); prompt_length = len(inputs)
        else:
            require(len(inputs) >= len(sequence) and inputs[:len(sequence)] == sequence, "nonlinear-token-history", "compaction, rewind, hidden branches or template rewrite broke exact token continuity")
            observation = inputs[len(sequence):]
            sequence.extend(observation); mask.extend([0] * len(observation)); logprobs.extend([0.0] * len(observation))
        sequence.extend(outputs); mask.extend([1] * len(outputs)); logprobs.extend(probs)
    require(sum(mask) > 0, "no-trainable-tokens", "episode must have at least one policy token")
    require(len(mask) == len(logprobs) == len(sequence) - prompt_length, "invalid-suffix", "Slime suffix includes all tool observations")
    return EpisodeSample(sequence, len(mask), mask, logprobs, reward, {
        "episodeId": episode["id"], "groupId": episode["groupId"], "slot": episode["slot"], "runId": episode["runId"],
        "policyVersion": episode["policyVersion"], "receiptIds": ids, "feedbackId": feedback["id"],
        "taskDigest": context["taskRef"]["digest"], "environmentDigest": context["environmentRef"]["digest"],
        "harnessDigest": context["harnessRef"]["digest"], "samplingDigest": digest_json(context["sampling"]),
    })


def admit_group(episodes, size, zero_variance="skip-with-bounded-resampling"):
    require(len(episodes) == size, "incomplete-group", "GRPO requires exactly G slots")
    require([e.metadata["slot"] for e in episodes] == list(range(size)), "duplicate-slot", "group slots must be unique and ordered")
    for key in ("groupId", "policyVersion", "taskDigest", "environmentDigest", "harnessDigest", "samplingDigest"):
        require(len({e.metadata[key] for e in episodes}) == 1, "mixed-group", "GRPO group mixed " + key)
    require(len({e.metadata["episodeId"] for e in episodes}) == size and len({e.metadata["runId"] for e in episodes}) == size, "duplicate-episode", "independent slots require independent executions")
    if len({e.reward for e in episodes}) == 1 and zero_variance != "keep":
        raise ContractError("zero-variance", "skip the whole constant-reward group and resample within budget")
    return episodes


def seal_batch(store, groups, request, lease, evidence_refs):
    require(lease["state"] == "closed", "batch-not-drained", "all Hitch runs, native requests and receipt writes must finish before sealing")
    require(len(groups) == request["trainer"]["rolloutBatchSize"], "incomplete-batch", "do not return an empty or undersized batch to stock GRPO")
    group_ids, run_ids = set(), set()
    for group in groups:
        admit_group(group, request["rollout"]["groupSize"], request["rollout"]["zeroVarianceGroup"])
        group_id = group[0].metadata["groupId"]
        require(group_id not in group_ids, "duplicate-group", "group replay would duplicate gradient samples")
        group_ids.add(group_id)
        for sample in group:
            require(sample.metadata["policyVersion"] == lease["policyVersion"] and sample.metadata["runId"] not in run_ids, "batch-policy-mismatch", "batch policy drift or duplicate run")
            run_ids.add(sample.metadata["runId"])
    groups_ref = store.put_json([[s.metadata for s in g] for g in groups])
    samples_ref = store.put_json([[asdict(s) for s in g] for g in groups])
    body = {"schemaVersion": request.get("schemaVersion", 1), "trainingRunId": request["trainingRunId"], "policyVersion": lease["policyVersion"],
            "recipeDigest": request["recipeDigest"], "datasetSplitDigest": request["datasetSplitDigest"],
            "groupsRef": groups_ref, "samplesRef": samples_ref, "sourceEvidenceDigest": digest_json(evidence_refs), "state": "sealed"}
    if request.get("schemaVersion", 1) == 2: body["sourceEvidenceRefs"] = evidence_refs
    return store.put_json({**body, "id": digest_json(body)})
