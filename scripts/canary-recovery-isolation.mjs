// Observe real RPC projections and scan public Hitch files using credentials
// kept only in this process's memory. No credential is persisted or printed.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { ModelNodeTransport } from '../lib/training/transport.js'
import { TrainingContentStore, atomicWrite, digestBytes } from '../lib/training/store.js'

const [root] = process.argv.slice(2); assert(root, 'usage: canary-recovery-isolation.mjs INPUT_ROOT')
const read = async n => JSON.parse(await readFile(join(root, n), 'utf8'))
const { request } = await read('training-payload.json'), deployment = await read('deployment-template.json'), hitch = await read('hitch-controller.json')
const { handle, node } = await read('recovery/marker.json')
const transport = new ModelNodeTransport(deployment.nodes[deployment.modelRuntime.nodeRef], node)
const store = new TrainingContentStore(join(root, 'controller-content'))
const forbidden = new Map([request.verifier, request.fixedHarness.manifestRef,
  ...request.trainDataset.tasks.flatMap(task => [task.taskRef, task.environmentRef])].map(ref => [ref.digest, ref]))
const secrets = new Set(), observed = new Set(), checked = new Set()
let finished = false, failure
let authorization
async function checkAuthorization(entry) {
  const endpoint = await transport.gateway(hitch.workspace, entry.intent.gateway.nodePort)
  const own = entry.intent.credential
  const call = async (method, path, credential, body) => {
    const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(5000),
      headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const content = await response.text(); assert(content.length <= 4096)
    return { method, path, status: response.status, response: content }
  }
  const active = await call('GET', '/v1/lease', own)
  if (active.status !== 200) return // A finished episode is not evidence of an active credential boundary.
  assert.equal(JSON.parse(active.response).episodeId, entry.intent.id)
  const results = []
  for (const [method, path, credential, body, expected] of [
    ['GET', '/v1/lease', null, null, 409],
    ['GET', '/v1/lease', 'invalid-diagnostic-credential', null, 409],
    ['POST', '/v1/chat/completions', null, {}, 401],
    ['POST', '/v1/chat/completions', 'invalid-diagnostic-credential', {}, 409],
    ['POST', '/v1/hitch/run', own, { runId: `run_${'0'.repeat(32)}`, bindingId: 'forbidden-other-binding' }, 409],
    ['POST', '/update_weights_from_disk', own, {}, 404],
    ['POST', '/generate', own, {}, 404],
    ['GET', '/server_info', own, null, 404],
    ['POST', '/training.cancel', own, {}, 404],
  ]) {
    const result = await call(method, path, credential, body); assert.equal(result.status, expected); results.push(result)
  }
  const crossRun = results.find(r => r.path === '/v1/hitch/run')
  if (JSON.parse(crossRun.response).error !== 'run-binding-conflict') return
  authorization = { kind: 'live-generation-authorization', actualGateway: true, passed: true,
    node, requestDigest: handle.requestDigest, episodeId: entry.intent.id, ownCredentialAccepted: true, results }
  await atomicWrite(join(root, 'generation-authorization.json'), authorization)
}
const deadline = Date.now() + (request.budgets.totalGpuSeconds + 120) * 1000
while (Date.now() < deadline) {
  let final
  try { final = await read('recovery/summary.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (final) { finished = true; failure = final.status !== 'passed'; break }
  const entries = await transport.call('training.episodes.list', { handle, renew: false, cursor: 0 })
  assert.equal(entries.nextCursor, null, 'bounded canary should have one small page of slots')
  for (const entry of entries.entries) {
    assert.match(entry.intent.credential, /^[a-f0-9]{64}$/)
    secrets.add(entry.intent.credential); observed.add(entry.intent.id)
    if (!authorization && !entry.cancelRequested) await checkAuthorization(entry)
    if (entry.result?.outcome === 'feedback') {
      const feedback = await store.readJson(entry.result.feedbackRef)
      const projection = await store.readJson(feedback.verifierEvidenceRef)
      forbidden.set(projection.sourceEvidenceRef.digest, projection.sourceEvidenceRef)
    }
  }
  for (const [digest] of forbidden) if (!checked.has(digest)) {
    assert.equal((await transport.call('cas.stat', { digest })).present, false, 'controller-only content reached model-node CAS')
    checked.add(digest)
  }
  await new Promise(resolve => setTimeout(resolve, 3000))
}
assert(finished && secrets.size >= 2, 'canary did not observe the complete real training group')
assert(authorization?.passed, 'canary did not verify a live run credential and rejected management/cross-run requests')
let files = 0
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await scan(path); continue }
    if (!entry.isFile()) continue
    files++; let tail = Buffer.alloc(0)
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.concat([tail, chunk])
      for (const secret of secrets) assert(!bytes.includes(Buffer.from(secret)), `model credential leaked into public file ${path}`)
      tail = bytes.subarray(Math.max(0, bytes.length - 63))
    }
  }
}
for (const directory of ['runs', 'evals']) await scan(join(hitch.root, directory))
await atomicWrite(join(root, 'information-isolation.json'), { kind: 'real-training-information-isolation', passed: true,
  trainingCompleted: !failure, node, requestDigest: handle.requestDigest, checkedControllerOnlyDigests: [...checked],
  credentialDigests: [...secrets].map(secret => digestBytes(secret)), episodeIds: [...observed], publicFilesScanned: files })
console.log(JSON.stringify({ informationIsolationPassed: true, trainingCompleted: !failure, credentials: secrets.size, publicFilesScanned: files }))
