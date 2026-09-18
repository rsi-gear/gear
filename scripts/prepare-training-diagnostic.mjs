// Build a train-only pending-gpu request from verified controller inputs and
// observations of the actual model node. This does not submit or certify a job.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { parseTrainingRequest } from '../lib/training/schema.js'
import { freezeExecutionPlacement } from '../lib/training/deployment.js'
import { digestJson } from '../lib/training/digest.js'

const [inputRoot, factsFile, output, nodeWorkspace, modelDirectory, updateCount = '1', attentionBackend = 'flash'] = process.argv.slice(2)
assert(inputRoot && factsFile && output && nodeWorkspace && modelDirectory,
  'usage: prepare-training-diagnostic.mjs INPUT_ROOT NODE_FACTS OUTPUT NODE_WORKSPACE MODEL_DIRECTORY [UPDATES=1|2] [ATTENTION=flash|unfused]')
assert(['1', '2'].includes(updateCount), 'diagnostic update count must be explicitly 1 or 2')
assert(['flash', 'unfused'].includes(attentionBackend), 'unsupported diagnostic attention backend')
const updates = Number(updateCount)
const read = async name => JSON.parse(await readFile(join(inputRoot, name), 'utf8'))
const facts = JSON.parse(await readFile(factsFile, 'utf8'))
const { model, modelRef } = await read('model-input.json')
const inputs = await read('task-inputs.json')
const config = await read('deployment-template.json')
const provider = await read('provider-observation.json')
const store = new TrainingContentStore(join(inputRoot, 'controller-content'))
assert.equal(facts.probe.runtimeDigest, digestJson(facts.probe.runtime))
const deployment = freezeExecutionPlacement(config, { node: facts.probe, provider: provider.provider })
const original = await read('actor-argument-seed.json')
const args = [...original.hyperparameters.slimeArgs]
for (const flag of ['--seq-length', '--max-position-embeddings']) args[args.indexOf(flag) + 1] = '1024'
// Keep the selected backend in the frozen hyperparameters. Unsupported kernels
// must fail on the node; a silent fallback changes the numerical experiment.
args.push('--lr-decay-style', 'constant', '--attention-backend', attentionBackend,
  '--recompute-granularity', 'full', '--recompute-method', 'uniform', '--recompute-num-layers', '1',
  '--sglang-attention-backend', 'triton', '--sglang-sampling-backend', 'pytorch',
  '--sglang-mem-fraction-static', '0.25', '--sglang-context-length', '1024',
  '--sglang-max-total-tokens', '2048', '--sglang-chunked-prefill-size', '512', '--sglang-max-running-requests', '1',
  '--sglang-disable-cuda-graph', '--sglang-disable-radix-cache', '--seed', '1234',
  '--save-debug-train-data', `${nodeWorkspace}/training-capture/rollout-{rollout_id}-rank-{rank}.pt`)
const hyperparameters = { schemaVersion: 1, slimeArgs: args }
const hyperparametersRef = await store.putJson(hyperparameters)
const runtimeLock = { schemaVersion: 2, runtime: { kind: 'python-env', nodeRuntimeDigest: facts.probe.runtimeDigest,
  outerImageDigest: facts.probe.runtime.outerImageDigest }, ...facts.versions, ...facts.git,
  pythonVersion: facts.probe.runtime.pythonVersion, hitchCommit: provider.controller.source.commit,
  bridgeDigest: facts.probe.runtime.bridgeDigest, protocolDigest: facts.protocolDigest, validation: 'pending-gpu', probeEvidenceRefs: [] }
const rollout = { provider: 'hitch', mode: 'synchronous', groupSize: 2, maxPolicyLag: 0,
  sampling: { temperature: 1, topP: 1, topK: -1, repetitionPenalty: 1, maxNewTokens: 256, maxContextTokens: 1024 },
  episodeFormat: 'linear-token-trajectory-v1', capture: 'exact-policy-tokens-v1', truncation: 'reject', zeroVarianceGroup: 'keep',
  compaction: false, subagents: false, auxiliaryModelCalls: false }
const request = parseTrainingRequest({ schemaVersion: 2, deployment,
  experimentId: `diagnostic-${facts.probe.generation}`, trainingRunId: `diagnostic-train-${facts.probe.generation}`,
  parentModel: model, parentModelRef: modelRef, referenceModelRef: modelRef, coldStart: true,
  fixedHarness: inputs.fixedHarness, trainDataset: inputs.trainDataset, verifier: inputs.verifier,
  trainer: { provider: 'slime', runtimeLock, recipe: 'agent-grpo-v1', backend: 'megatron', hyperparametersRef,
    updatesPerCandidate: updates, checkpointEveryUpdate: true, optimizerResetPolicy: 'initial-cold-start-only',
    rolloutBatchSize: 1, globalBatchSize: 2, dataParallelSize: 1 }, rollout,
  budgets: { totalGpuSeconds: 2400, maxRolloutTokens: 4096, maxEpisodeSteps: 4, maxGroupResamples: 1 },
  trainingDevices: [{ nodeId: facts.probe.nodeId, gpuUuid: facts.probe.gpuUuids[0] }],
  recipeDigest: digestJson({ hyperparametersRef, rollout }), datasetSplitDigest: digestJson(inputs.trainDataset) })
// Match production admission's explicit descriptor/file allowlist. Model
// provenance may reference private historical controller evidence.
const queue = [modelRef, model.hfSnapshotRef, hyperparametersRef], seen = new Set(), jsonObjects = []
for (const ref of queue) {
  if (seen.has(ref.digest)) continue
  seen.add(ref.digest)
  if (ref.mediaType !== 'application/json') continue
  const value = await store.readJson(ref)
  jsonObjects.push({ ref, value })
}
await atomicWrite(output, { kind: 'gear-full-driver-diagnostic', validated: false, request, jsonObjects, modelDirectory })
console.log(JSON.stringify({ requestDigest: digestJson(request), jsonObjects: jsonObjects.length,
  modelRef, trainingDevices: request.trainingDevices, runtimeValidation: runtimeLock.validation }))
