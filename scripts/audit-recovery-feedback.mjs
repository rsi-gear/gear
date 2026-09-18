// Audit durable controller projections after collection, including feedback
// consumed too quickly for the live journal poll to observe its result.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelNodeTransport } from '../lib/training/transport.js'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { digestJson } from '../lib/training/digest.js'

const [root] = process.argv.slice(2); assert(root, 'usage: audit-recovery-feedback.mjs INPUT_ROOT')
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
const { request } = await read('training-payload.json'), hitch = await read('hitch-controller.json')
const deployment = await read('deployment-template.json'), { handle, node } = await read('recovery/marker.json')
const recovered = await read('recovery/summary.json'); assert.equal(recovered.status, 'passed')
assert.equal(handle.requestDigest, digestJson(request))
const store = new TrainingContentStore(join(root, 'controller-content'))
const transport = new ModelNodeTransport(deployment.nodes[deployment.modelRuntime.nodeRef], node)
const directory = join(hitch.workspace, 'training-episodes', handle.jobId)
const forbidden = new Map(), runs = new Set(), projections = []
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const state = JSON.parse(await readFile(join(directory, entry.name, 'state.json'), 'utf8'))
  assert(state.result, 'all physical slots must have a durable terminal result')
  if (state.result.evidenceRef) forbidden.set(state.result.evidenceRef.digest, state.result.evidenceRef)
  if (state.result.outcome !== 'feedback') continue
  const feedback = await store.readJson(state.result.feedbackRef), episode = await store.readJson(state.result.episodeRef)
  const projection = await store.readJson(feedback.verifierEvidenceRef)
  assert.equal(projection.kind, 'controller-verifier-observation'); assert.equal(projection.valid, true)
  assert.equal(projection.verifierVersion, request.verifier.digest)
  assert.equal(projection.runId, feedback.runId); assert.equal(episode.runId, feedback.runId)
  assert.equal(episode.id, feedback.episodeId); assert.equal(episode.feedbackId, feedback.id)
  assert(!runs.has(feedback.runId)); runs.add(feedback.runId)
  // readJson also verifies the original local content-addressed bytes.
  await store.readJson(projection.sourceEvidenceRef)
  forbidden.set(projection.sourceEvidenceRef.digest, projection.sourceEvidenceRef)
  projections.push({ runId: feedback.runId, feedbackRef: state.result.feedbackRef,
    projectionRef: feedback.verifierEvidenceRef, controllerOnlyRef: projection.sourceEvidenceRef })
}
assert.equal(runs.size, request.trainer.updatesPerCandidate * request.trainer.rolloutBatchSize * request.rollout.groupSize)
for (const [digest] of forbidden) assert.equal((await transport.call('cas.stat', { digest })).present, false,
  'raw controller verifier/canonical evidence reached model-node CAS')
const result = { kind: 'durable-controller-feedback-isolation', passed: true, node,
  requestDigest: handle.requestDigest, projections, checkedControllerOnlyDigests: [...forbidden.keys()] }
await atomicWrite(join(root, 'feedback-isolation.json'), result)
console.log(JSON.stringify({ feedbackIsolationPassed: true, runs: runs.size, privateObjects: forbidden.size }))
