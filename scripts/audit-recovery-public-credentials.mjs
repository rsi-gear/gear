// Scan final public artifacts for every durable training credential, including
// episodes from incarnations that ended before a live observer reconnected.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { digestJson } from '../lib/training/digest.js'
import { atomicWrite, digestBytes } from '../lib/training/store.js'

const root = process.argv[2]; assert(root, 'usage: audit-recovery-public-credentials.mjs INPUT_ROOT')
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
const hitch = await read('hitch-controller.json'), { request } = await read('training-payload.json')
const { handle, node } = await read('recovery/marker.json')
assert.equal(digestJson(request), handle.requestDigest)
assert.equal((await read('recovery/summary.json')).status, 'passed')
assert.equal((await read('independent-evaluation/summary.json')).status, 'passed')
const directory = join(hitch.workspace, 'training-episodes', handle.jobId)
const secrets = new Set(), episodeIds = new Set()
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const slot = join(directory, entry.name)
  const state = JSON.parse(await readFile(join(slot, 'state.json'), 'utf8'))
  const intent = JSON.parse(await readFile(join(slot, 'intent.json'), 'utf8'))
  assert.equal(intent.inputDigest, state.intentDigest)
  assert.equal(state.result?.outcome, 'feedback')
  assert.match(intent.credential, /^[a-f0-9]{64}$/)
  assert(!episodeIds.has(intent.id)); episodeIds.add(intent.id); secrets.add(intent.credential)
}
const expected = request.trainer.updatesPerCandidate * request.trainer.rolloutBatchSize * request.rollout.groupSize
assert.equal(episodeIds.size, expected); assert.equal(secrets.size, expected)
let files = 0
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await scan(path); continue }
    if (!entry.isFile()) continue
    files++; let tail = Buffer.alloc(0)
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.concat([tail, chunk])
      for (const secret of secrets) assert(!bytes.includes(Buffer.from(secret)), `training credential leaked into public file ${path}`)
      tail = bytes.subarray(Math.max(0, bytes.length - 63))
    }
  }
}
for (const directory of ['runs', 'evals']) await scan(join(hitch.root, directory))
const result = { kind: 'durable-training-credential-isolation', passed: true, node,
  requestDigest: handle.requestDigest, credentialDigests: [...secrets].map(secret => digestBytes(secret)),
  episodeIds: [...episodeIds], publicFilesScanned: files }
await atomicWrite(join(root, 'credential-isolation.json'), result)
console.log(JSON.stringify({ passed: true, credentials: secrets.size, publicFilesScanned: files }))
