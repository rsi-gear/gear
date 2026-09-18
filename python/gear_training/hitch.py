"""Public Hitch CLI client. No deep imports and no writes to Hitch's run store."""
from __future__ import annotations

import asyncio
import json
import re
from .content import ContractError, require, canonical
from pathlib import Path


def frozen_harness_ref(request, config):
    return request["fixedHarness"]["adapter"] + "@git+" + Path(config["hitchPath"]).resolve().as_uri() + "#" + request["fixedHarness"]["commit"]


def matches_harness_ref(actual, submitted):
    # Only a full frozen Git commit can produce Harbor's canonical reference.
    match = re.fullmatch(r"([^@]+)@git\+.+#([a-f0-9]{40})", submitted)
    return actual == submitted or bool(match and actual == match[1] + "@commit:" + match[2])


class HitchClient:
    def __init__(self, command, root, timeout=60):
        require(isinstance(command, list) and command and all(isinstance(s, str) and s for s in command), "invalid-hitch-command", "Hitch executable must be an argv array")
        self.command, self.root, self.timeout = command, str(root), timeout

    async def call(self, args, payload=None, timeout=None, allow_failure=False):
        process = await asyncio.create_subprocess_exec(*self.command, "--root", self.root, *args,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(None if payload is None else canonical(payload).encode()), timeout or self.timeout)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        require(len(stdout) <= 16 * 1024 * 1024, "hitch-output-overflow", "Hitch JSON output exceeded its bound")
        try:
            result = json.loads(stdout)
        except (ValueError, UnicodeDecodeError):
            raise ContractError("invalid-hitch-json", "Hitch did not return structured JSON")
        if not allow_failure:
            require(process.returncode == 0, "hitch-operation-failed", "Hitch operation failed: " + str(result.get("error", {}).get("code", process.returncode)))
        return result

    async def capabilities(self):
        result = await self.call(["capabilities", "--json"])
        for field in ("training_external_binding", "exact_policy_tokens", "training_policy_fencing"):
            require(result.get(field) == "1", "hitch-capability-missing", "Hitch cannot satisfy " + field)
        require("training-tool" in result.get("training_harnesses", []), "unsupported-hitch-harness", "Hitch lacks the tested linear training harness")
        return result

    async def register(self, binding, endpoint, credential):
        result = await self.call(["training", "register", "--file", "-"], {"schema_version": "1", "binding": binding, "base_url": endpoint + "/v1", "credential": credential})
        require(result.get("binding") == binding, "hitch-registration-mismatch", "Hitch changed the episode binding")

    async def submit(self, *, dataset, harness, binding_path, binding, key, timeout_seconds):
        result = await self.call(["eval", "submit", "--dataset", str(dataset), "--harness", harness, "--model", "training/" + binding["bindingId"],
            "--attempts", "1", "--max-concurrent", "1", "--infrastructure-retries", "0", "--training-binding-file", str(binding_path),
            "--provider", "local-docker", "--model-capture", "proxy", "--require-model-capture", "--timeout", str(timeout_seconds) + "s", "--idempotency-key", key])
        require(isinstance(result.get("eval_id"), str), "missing-hitch-handle", "Hitch submission has no durable eval handle")
        return result["eval_id"]

    async def inspect(self, eval_id):
        return await self.call(["eval", "inspect", eval_id, "--json"])

    async def cancel(self, eval_id):
        return await self.call(["eval", "cancel", eval_id], allow_failure=True)

    async def verifier(self, run_id):
        return await self.call(["verifier", "inspect", run_id, "--json"])

    async def training_evidence(self, run_id):
        return await self.call(["training", "evidence", run_id, "--json"])

    async def run_record(self, run_id):
        return await self.call(["runs", "inspect", run_id, "--json"])


def validate_training_run(store, loaded, context, eval_id, harness_ref):
    record = loaded.get("record", {})
    require(loaded.get("record_status") == "valid" and loaded.get("trajectory_status") != "corrupt", "corrupt-training-run", "canonical run integrity check failed")
    task, parent, model, harness, protocol = (record.get(k, {}) for k in ("context", "parent", "model", "harness", "protocol"))
    environment = store.read_json(context["environmentRef"])
    expected_harness = store.read_json(context["harnessRef"])["hitch"]
    require(record.get("run_id") == context["runId"] and parent.get("eval_id") == eval_id and parent.get("attempt") == 1
            and task.get("kind") == "benchmark_task" and task.get("task_id") == context["taskId"]
            and task.get("task_digest") == environment["taskDigest"] and task.get("verifier_identity") == environment["verifierIdentity"]
            and protocol.get("environment_identity") == environment["hitchEnvironmentIdentity"]
            and model.get("provider") == "slime-training" and model.get("effective_id") == context["policyVersion"]
            and model.get("identity_resolved") is True and harness.get("harness_id") == expected_harness["harnessId"]
            and harness.get("revision_identity") == expected_harness["revisionIdentity"] and harness.get("artifact_id") == expected_harness["artifactId"]
            and matches_harness_ref(harness.get("requested_ref"), harness_ref),
            "training-canonical-identity-drift", "actual Hitch task/verifier/environment/harness/policy differs from its frozen training slot")
    return record


def canonical_trial(inspection, binding):
    """Only finished, canonical verifier observations can supply rewards."""
    request = inspection.get("request", {})
    # Control-plane inspection can wrap request in its durable submission.
    request = request.get("request", request)
    require(request.get("training_binding") == binding, "hitch-binding-mismatch", "Hitch inspection lost the frozen training binding")
    result = inspection.get("result")
    if not result:
        return None
    require(result.get("status") in ("succeeded", "failed", "cancelled", "timed_out"), "unknown-hitch-status", "unknown Hitch terminal status")
    trials = result.get("trials", [])
    require(len(trials) == 1, "hitch-slot-mismatch", "one episode must produce exactly one canonical task slot")
    trial = trials[0]
    require(isinstance(trial.get("run_id"), str) and trial.get("attempt", 1) == 1, "hitch-run-mismatch", "Hitch canonical logical slot is missing")
    return trial
