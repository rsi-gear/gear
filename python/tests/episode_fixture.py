"""CPU-only exact native episode fixtures shared by journal/rollout tests."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

from gear_training.content import ContentStore, atomic_json, digest_bytes, digest_json
from gear_training.episodes import EpisodeJournal
from gear_training.ledger import Ledger
from gear_training.recipes.agent_grpo import sampling_params


class EpisodeFixture:
    def __init__(self, root):
        self.directory = Path(root) / ("job_" + "a" * 32)
        self.store = ContentStore(Path(root) / "node-content")
        self.ref = self.store.put_json({"native": "evidence"})
        # These objects deliberately do not exist in the model-node CAS.
        self.private = {"uri": "cas:" + digest_json("controller-private"), "digest": digest_json("controller-private"), "mediaType": "application/json"}
        self.request = {"schemaVersion": 2, "trainingRunId": "train-test", "recipeDigest": self.ref["digest"], "datasetSplitDigest": self.ref["digest"],
            "trainer": {"rolloutBatchSize": 1, "globalBatchSize": 2, "dataParallelSize": 1, "runtimeLock": {"protocolDigest": self.ref["digest"]}},
            "rollout": {"groupSize": 2, "zeroVarianceGroup": "keep", "sampling": {"temperature": 1, "topP": 1, "topK": -1, "repetitionPenalty": 1, "maxNewTokens": 16, "maxContextTokens": 128}},
            "parentModel": {"id": self.ref["digest"], "tokenizerDigest": self.ref["digest"], "chatTemplateDigest": self.ref["digest"]},
            "fixedHarness": {"manifestRef": self.private}, "verifier": self.private,
            "trainDataset": {"tasks": [{"id": "train", "taskRef": self.private, "environmentRef": self.private}]},
            "trainingDevices": [{"nodeId": "cpu-fixture", "gpuUuid": "GPU-fixture"}],
            "budgets": {"totalGpuSeconds": 60, "maxRolloutTokens": 2000, "maxEpisodeSteps": 4, "maxGroupResamples": 1}}
        self.config = {"schemaVersion": 2, "storeRoot": str(self.store.root), "controllerTimeoutSeconds": 10,
                       "gatewayBindHost": "127.0.0.1", "gatewayPort": 31001}
        self.sampling = sampling_params(self.request["rollout"])
        self.lease = {"schemaVersion": 1, "trainingRunId": "train-test", "batchId": "batch-0", "policyVersion": "runtime-1/update-0",
            "parentModelVersionId": self.ref["digest"], "synchronizedWeightsRef": self.ref, "runtimeInstanceId": "runtime-1",
            "samplingDigest": digest_json(self.sampling), "fencingToken": "fence-0",
            "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), "state": "serving"}
        self.replicas = [{"weightsDigest": self.ref["digest"], "runtimeInstanceId": "runtime-1", "policyVersion": self.lease["policyVersion"], "replicaId": "engine-0"}]
        self.persist()
        self.ledger = Ledger(self.directory / "ledger.sqlite")
        self.ledger.open_lease(self.lease, self.replicas)
        self.ledger.require_controller(self.lease["batchId"], 10)
        self.journal = EpisodeJournal(self.directory, self.ledger)

    def persist(self, rollout_id=0):
        for name, value in {"request": self.request, "config": self.config, "worker": {"incarnation": "incarnation-1"},
                            "runtime": {"lease": self.lease, "replicas": self.replicas, "rolloutId": rollout_id, "weightVersion": "0", "engineUrl": "http://native-fixture"}}.items():
            atomic_json(self.directory / (name + ".json"), value)

    def publish(self, slot=0):
        context = {"id": "episode-" + str(slot), "groupId": "group-0", "slot": slot, "runId": None, "taskId": "train", "logicalAttempt": 1,
            "policyVersion": self.lease["policyVersion"], "runtimeInstanceId": "runtime-1", "tokenizerDigest": self.ref["digest"], "chatTemplateDigest": self.ref["digest"],
            "harnessRef": self.private, "taskRef": self.private, "environmentRef": self.private, "sampling": self.sampling,
            "maxContextTokens": 128, "maxEpisodeSteps": 4, "maxRolloutTokens": 2000, "verifierVersion": self.private["digest"],
            "trainingRunId": "train-test", "batchId": "batch-0", "bindingId": "binding_" + digest_json(slot)[7:39],
            "wireModel": self.lease["policyVersion"], "generationContractDigest": self.ref["digest"]}
        credential = digest_json(["credential", slot])[7:]
        self.ledger.register_episode(context, digest_bytes(credential.encode()))
        binding = {"kind": "training-external", "bindingId": context["bindingId"], "trainingRunId": "train-test", "policyLeaseRef": self.store.put_json(self.lease),
            "expectedPolicyVersion": self.lease["policyVersion"], "fencingToken": self.lease["fencingToken"], "expiresAt": self.lease["expiresAt"],
            "endpointRef": "hitch-training:" + context["bindingId"], "credentialRef": "hitch-training:" + context["bindingId"],
            "generationContractDigest": self.ref["digest"], "requiredCapture": "exact-policy-tokens-v1", "api": "chat-completions", "maxOutputTokens": 16, "maxEpisodeSteps": 4}
        return self.journal.publish(context, binding, credential, self.config["gatewayPort"])

    @staticmethod
    def address(intent):
        return {**{k: intent[k] for k in ("id", "inputDigest", "jobId", "incarnation")},
                **{k: intent["lease"][k] for k in ("batchId", "policyVersion", "fencingToken")}}

    def generate(self, intent, bad_history=False):
        run_id = "run_" + digest_json(intent["id"])[7:39]
        context = self.ledger.bind_run(digest_bytes(intent["credential"].encode()), "runtime-1", run_id, intent["binding"]["bindingId"])
        refs = []
        for index, (inputs, outputs, probs) in enumerate([([1, 2], [3, 4], [-.1, -.2]), ([1, 2, 3, 4, 90, 91], [5], [-.3])]):
            if index and bad_history: inputs[0] = 99
            request_id = intent["id"] + "/" + str(index)
            self.ledger.begin_request(context, request_id, digest_json(inputs))
            receipt = {"schemaVersion": 1, "id": "receipt_" + digest_json(request_id)[7:39], "episodeId": context["id"], "callIndex": index, "requestId": request_id,
                **{k: context[k] for k in ("runId", "taskId", "logicalAttempt", "policyVersion", "runtimeInstanceId", "tokenizerDigest", "chatTemplateDigest")},
                "effectiveSamplingRef": self.store.put_json(self.sampling), "inputTokenIdsRef": self.store.put_json(inputs), "outputTokenIdsRef": self.store.put_json(outputs),
                "behaviorLogProbsRef": self.store.put_json(probs), "rawRequestRef": self.ref, "rawResponseRef": self.ref, "finishReason": "stop", "complete": True}
            ref = self.store.put_json(receipt); refs.append(ref); self.ledger.complete_request(request_id, ref)
        return refs

    def feedback(self, intent, reward=0):
        address = self.address(intent)
        eval_id = "eval_" + digest_json(intent["id"])[7:39]
        self.journal.acknowledge(address, {"evalId": eval_id})
        context = self.ledger.context(intent["id"])
        receipts = self.journal.receipts(address)
        feedback = {"schemaVersion": 1, "id": "feedback_" + digest_json(intent["id"])[7:39], "episodeId": intent["id"], "runId": context["runId"],
            "receiptIds": [self.store.read_json(ref)["id"] for ref in receipts["receiptRefs"]], "verifierVersion": self.private["digest"],
            "verifierEvidenceRef": self.ref, "outcome": "valid", "reward": reward}
        episode = {"schemaVersion": 1, **{k: context[k] for k in ("id", "groupId", "slot", "runId", "policyVersion", "harnessRef", "taskRef", "environmentRef")},
            "receiptIds": feedback["receiptIds"], "feedbackId": feedback["id"], "termination": "terminated", "eligibility": "eligible", "rejectionReasons": []}
        assembly = {"schemaVersion": 2, "kind": "controller-episode-verification", "episodeId": intent["id"], "runId": context["runId"],
            "taskDigest": self.private["digest"], "environmentDigest": self.private["digest"], "harnessDigest": self.private["digest"],
            "verifierVersion": self.private["digest"], "feedbackDigest": digest_json(feedback)}
        return {"schemaVersion": 2, "outcome": "feedback", "evalId": eval_id, "episodeRef": self.store.put_json(episode),
                "feedbackRef": self.store.put_json(feedback), "assemblyRef": self.store.put_json(assembly)}

    def close(self):
        self.ledger.close()
