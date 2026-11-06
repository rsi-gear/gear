# Independent evaluation through model endpoints

Gear evaluates an already deployed model API. Hitch owns evaluation tasks and their requests; the deployment owner and upstream SGLang/Model Gateway own model loading, replicas, GPU allocation and service recovery. The retained training rollout still uses exact policy tokens, leases/fencing, Slime synchronization, checkpoints and immutable HF exports.

The fixed-version [Hitch upstream deployment examples](https://github.com/rsi-gear/agent-hitch/tree/main/examples/external-inference) provide one SGLang replica, a TP=2 variant, two TP=1 replicas behind the official Gateway, and a one-shot standard HTTP acceptance probe. The ordinary Hitch client does not install a custom inference wheel, Python, CUDA or an engine. Training and task tools keep their own actual dependencies.

## Select and verify an endpoint

Register one explicit API configuration, with a versioned wire model and a credential reference:

```json
{
  "schema_version": "1",
  "base_url": "http://inference.internal:30000/v1",
  "wire_model": "coder-baseline-001",
  "api": "chat-completions",
  "auth": {"kind": "env", "name": "CODER_API_KEY"},
  "capabilities": {
    "streaming": true,
    "tool_calls": true,
    "parallel_tool_calls": false,
    "input_modalities": ["text"]
  }
}
```

```sh
hitch models connect --name baseline-001 --file endpoint.json
hitch models inspect endpoint/baseline-001 --verify --json
```

`connect` persists a connection; it does not deploy or download a model. `inspect` exposes the immutable `endpoint_ref` and `endpoint_revision` with the public binding fields. Its registry-level `generation` is empty; freeze the actual generation parameters in the ready evaluation binding below. Verification checks protocol behavior, not loaded-weight identity. This release verifies serial function tool calls; `parallel_tool_calls` must be `false`. The endpoint's API root retains its path prefix; select `responses` explicitly only for a Harness that requires and has verified that protocol. Worker/Harbor networking and the secret must be available in the process that actually sends the upstream request. A container's loopback address is not its model host.

## Prepare a binding for each immutable HF version

The external-file mode uses this private configuration in v1/v2 controllers. New v2 experiments can explicitly freeze a [managed native profile](managed-native.zh-CN.md); see the [unattended iteration guide](unattended-iteration.zh-CN.md) for automatic rounds.

```json
{
  "evaluationBindings": {
    "bindingsFile": "/srv/gear/deployments/by-hf-digest.json",
    "trustedReceiptSources": ["ci-gpu-deploy"]
  }
}
```

The map indexes existing model artifact digests, including the initial baseline and each newly exported candidate:

```json
{
  "schemaVersion": 1,
  "bindings": {
    "sha256:<baseline model.hfSnapshotRef.digest hex>": "/srv/gear/deployments/baseline.ready.json",
    "sha256:<candidate model.hfSnapshotRef.digest hex>": "/srv/gear/deployments/candidate.ready.json"
  }
}
```

These placeholders must be replaced with actual digests. Copy the editable [ready-binding template](../../examples/training-loop/terminal-bench-2.1/endpoint-binding.example.json) and [digest-map template](../../examples/training-loop/terminal-bench-2.1/evaluation-bindings.example.json), then replace every placeholder with actual deployment values. A ready file contains the public fields from `models inspect`, an explicit generation object, the private connection and a receipt from the trusted deployment workflow:

```json
{
  "schema_version": "1",
  "kind": "external-endpoint",
  "endpoint_ref": "endpoint/baseline-001",
  "endpoint_revision": "sha256:<actual immutable registration revision hex>",
  "api": "chat-completions",
  "wire_model": "coder-baseline-001",
  "capabilities": {
    "streaming": true,
    "tool_calls": true,
    "parallel_tool_calls": false,
    "input_modalities": ["text"]
  },
  "generation": {"max_output_tokens": 1024, "temperature": 0},
  "deployment_receipt": {
    "schema_version": "1",
    "model_digest": "sha256:<baseline model.hfSnapshotRef.digest hex>",
    "wire_model": "coder-baseline-001",
    "deployment_ref": "gpu-deployment-run-001",
    "source": "ci-gpu-deploy",
    "service_config": {
      "engine": "sglang",
      "engine_version": "0.5.21",
      "engine_digest": "sha256:<actual pulled image digest hex>",
      "quantization": "none",
      "tool_parser": "qwen25",
      "tokenizer_digest": "sha256:<actual tokenizer digest hex>",
      "chat_template_digest": "sha256:<actual template digest hex>",
      "cache_policy": "shared-radix-cache",
      "isolation": "static-separate-training-inference-devices"
    }
  },
  "connection": {
    "base_url": "http://inference.internal:30000/v1",
    "auth": {"kind": "env", "name": "CODER_API_KEY"}
  }
}
```

The machine-readable contract is [ready-evaluation-endpoint-binding-v1.schema.json](../schemas/ready-evaluation-endpoint-binding-v1.schema.json). Copy only the required binding fields from inspection; omit diagnostic `identity_verified`/`verification` fields. The normalized connection, API, model name, auth reference and capabilities must match the registered revision. Receipt `model_digest` must match the requested model's existing HF snapshot digest, and its `wire_model` must match the binding. The deployment workflow must verify the mounted immutable snapshot and receipt provenance. A self-written digest, source string or `/models` echo is not loading proof. Keep credentials and connection URLs outside public receipt `service_config` and public evaluation evidence.

The external-file preparer reads these files without deployment authority. A missing map entry or ready file persists `endpointPreparations.status="waiting"` and reports `waiting-for-deployment`. Supply the corresponding version's binding, then continue the same run. Gear saves the preparation intent and ready binding before submitting evaluation and reuses them after a crash. Retries do not re-resolve mutable aliases or publish candidates. Explicit managed-native mode can prepare owned services; a rebuilt incarnation requires a bounded new endpoint attempt retaining the original binding and all valid slots. Existing external experiments gain no authority from controller edits. Different versions need not remain resident simultaneously.

## Freeze comparison conditions and task concurrency

The experiment uses `evaluation.provider="hitch-endpoint"` and `evaluation.topology="harbor-dataset"`. Its public comparison conditions are:

| Field | Value |
| --- | --- |
| `evaluation.common.runtimeDigest` | `digestJson(binding.deployment_receipt.service_config)` |
| `evaluation.common.protocolDigest` | `digestJson({api: binding.api})` |
| `evaluation.common.samplingDigest` | `digestJson(binding.generation)` |
| `evaluation.common.budgetsDigest` | `digestJson(controller.hitch.budgets)` |

Use the existing canonical `digestJson` helper; hashing formatted JSON text produces a different value. Weights and fixed Harness identity belong to the evaluation subject. Endpoint reference/revision, wire model, receipt and private connection belong to the frozen binding. Candidate-specific identity does not enter common conditions. Engine, quantization, parsing, tokenizer/template, cache and isolation settings still affect comparison and must remain equivalent for paired evidence. Re-establish the baseline when conditions change.

`hitch.budgets.maxConcurrent` is trial concurrency, not a GPU or replica count. Gateway and engine limits are configured by the deployment owner. Generation budgets pass unchanged: use normal business values such as 1024 or 4096, with no `+2` adjustment or tiny-budget acceptance gate. Strict evaluation disables transparent request retries and cross-model fallback in Gateway, SDK and Harness. Already-started streams are never transparently replayed.

## Resources, cancellation and usage

New `resources` contain only `trainingDevices` (UUID strings in v1, `{nodeId,gpuUuid}` objects in v2). V2 uses `deployment.gpuScheduling.trainEvaluation="isolated"`. Inference GPUs are statically reserved by the deployment owner and excluded from the trainer's actual device access. `actorRollout="colocated"` remains a training-internal option; it does not enable ordinary evaluation to share those GPUs. Visibility variables alone are not global mutual exclusion.

Completing or cancelling an eval ends its tasks and requests. It does not stop/drain a shared model service, flush its cache, release its GPUs, or affect another consumer. `evaluationTasksCompleted` records task completion separately from training `resourcesReleased`; only the deployment/resource owner can attest inference resource release.

Evaluation records actual tokens, request counts and elapsed time when available. Without a reliable deployment-side meter, inference `gpuSeconds` and `gpuSecondsSource` are `null`, never zero or the entire shared pool's cost. New experiment budgets must explicitly set `gpuSecondsScope="training"`; `totalGpuSeconds` then covers training GPU time only. `gpuSecondsScope="total"` is rejected until reliable inference metering exists. Existing cumulative training accounting remains monotonic and deduplicated.

Explicit publication seals an approved artifact pointer (`hitchModel=local/<digest>`) through the retained CAS/model import path. That pointer does not create a callable endpoint. Subsequent inference needs a separately prepared endpoint binding for the approved snapshot.

## Acceptance and historical records

Bounded GPU validation on 2026-10-15 covered real SGLang TP=2, two TP=1 workers through official SMG, both APIs, worker distribution/cancellation isolation and actual Codex tool tasks; see the [inference topology record](../validation/external-inference-gpu-2026-10-15.md). A separate [training and endpoint diagnostic](../validation/training-gpu-loop-2026-10-15.md) used GPU 0 for real Slime rollout, one update and native/HF export, with an ordinary SGLang TP=1 endpoint on GPU 1. Real local Harbor/Docker baseline and candidate evaluations passed strict endpoint verification and evidence pairing, with valid reward 0 for both and meanDelta 0. This was explicitly `validated:false` with a `pending-gpu` runtime lock; zero loss/gradient does not establish learning or formal runtime certification. Complete local artifact closure (108 objects, 35,467,670,234 bytes), offline finite verification and exact-instance rental destruction passed. Compose containers, a complete Harbor benchmark, remote Harbor workers and held-out quality remain unvalidated. CPU/controlled HTTP checks establish software contracts only.

After building Gear and Hitch, run the real CLI/daemon software contract smoke from the Gear repository:

```sh
GEAR_TEST_HITCH=/absolute/path/to/agent-hitch/dist/bin/hitch.js node scripts/check-training-endpoint-contract.mjs
```

It uses a controlled standard HTTP endpoint and the actual Hitch CLI/daemon to check binding acceptance and rejection, registration/verification, protocol behavior and public redaction. It does not execute Harbor or a GPU engine.

Historical locks, evidence and certification retain their original digests and meaning. They do not certify the new upstream deployment, and old task identities are not silently rebound. Stop any old running service with its old-version deployment tools before removing its environment; deleting a ledger is not process/GPU release proof. See the [endpoint specification](../model-api-inference-service-spec.zh-CN.md) for the complete boundary.
