// Exercise the production model upload allowlist over the actual node RPC.
// This preflight-only probe never submits a job or starts a model process.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NodeSlimeModelTrainer } from '../lib/training/slime.js'
import { ModelNodeTransport } from '../lib/training/transport.js'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { sealModelVersion } from '../lib/training/schema.js'
import { digestJson } from '../lib/training/digest.js'

const [root] = process.argv.slice(2)
assert(root, 'usage: canary-node-information-isolation.mjs INPUT_ROOT')
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
const { request } = await read('training-payload.json'), deployment = await read('deployment-template.json')
const { node, handle } = await read('recovery/marker.json')
assert.equal(handle.requestDigest, digestJson(request))
const connection = deployment.nodes[deployment.modelRuntime.nodeRef]
assert.equal(connection.transport.type, 'ssh')
const transport = new ModelNodeTransport(connection, node)
const observed = await transport.call('probe', {})
assert.equal(observed.runtimeDigest, request.deployment.modelRuntime.runtimeDigest)
const store = new TrainingContentStore(join(root, 'controller-content'))
const classes = ['dev', 'held-out', 'private-verifier', 'admin-credential']
const markers = classes.map(name => `GEAR-ISOLATION-${name}-${randomBytes(16).toString('hex')}`)
const privateRefs = await Promise.all(markers.map(marker => store.putJson({ marker })))
const originalSnapshot = await store.readJson(request.parentModel.hfSnapshotRef)
const configFile = originalSnapshot.files.find(file => file.path === 'config.json')
assert(configFile && configFile.size < 64 * 1024)
// Only a bounded model configuration is read back; weights stay on the node.
await transport.download(store, configFile.contentRef)
const configuration = JSON.parse((await store.readBytes(configFile.contentRef)).toString())
const configRef = await store.putJson({ ...configuration, diagnosticMetadata: { references: privateRefs } })
const configBytes = await store.readBytes(configRef)
const snapshot = { ...originalSnapshot, files: originalSnapshot.files.map(file => file.path === 'config.json'
  ? { ...file, size: configBytes.length, sha256: configRef.digest, contentRef: configRef } : file) }
const snapshotRef = await store.putJson(snapshot)
const { id: _id, ...parent } = request.parentModel
const variant = structuredClone(request)
variant.parentModel = sealModelVersion({ ...parent, hfSnapshotRef: snapshotRef, provenanceRef: privateRefs[0] })
variant.parentModelRef = await store.putJson(variant.parentModel)
const uploads = [], upload = transport.upload.bind(transport)
transport.upload = async (...args) => { uploads.push(args[1]); return upload(...args) }
const trainer = new NodeSlimeModelTrainer(transport, store, { preflight: async () => {} })
const preflight = await trainer.preflight(variant)
assert(preflight.blockers.length > 0 && preflight.blockers.every(value => value === 'gpu-probes-pending'
  || value === 'training-gpu-pool-occupied' || value.startsWith('missing-runtime-probe-evidence:')))
assert(uploads.some(ref => ref.digest === configRef.digest))
for (const ref of privateRefs) {
  assert(!uploads.some(uploaded => uploaded.digest === ref.digest))
  assert.equal((await transport.call('cas.stat', { digest: ref.digest })).present, false)
}
const uploadedJsonObjects = []
for (const ref of new Map(uploads.filter(ref => ref.mediaType === 'application/json').map(ref => [ref.digest, ref])).values()) {
  const bytes = await store.readBytes(ref)
  assert(bytes.length < 256 * 1024)
  for (const marker of markers) assert(!bytes.includes(Buffer.from(marker)))
  assert.equal((await transport.call('cas.stat', { digest: ref.digest })).size, bytes.length)
  uploadedJsonObjects.push({ digest: ref.digest, size: bytes.length })
}
const poisoned = await store.putJson({ ...snapshot, provenance: privateRefs[1] })
const invalid = structuredClone(variant)
invalid.parentModel = sealModelVersion({ ...parent, hfSnapshotRef: poisoned })
invalid.parentModelRef = await store.putJson(invalid.parentModel)
const before = uploads.length
await assert.rejects(trainer.preflight(invalid), error => error?.code === 'model-input-reference-leak')
assert(!uploads.slice(before).some(ref => ref.digest === poisoned.digest))
assert.equal((await transport.call('cas.stat', { digest: poisoned.digest })).present, false)
await atomicWrite(join(root, 'remote-cas-isolation.json'), { kind: 'real-remote-cas-information-isolation', validated: false,
  passed: true, node, requestDigest: handle.requestDigest, variantRequestDigest: digestJson(variant),
  actualSshRpc: true, jobSubmitted: false, classes, controllerOnlyRefs: privateRefs,
  uploadedJsonObjects, undeclaredManifestReferenceRejected: true })
console.log(JSON.stringify({ remoteCasIsolationPassed: true, privateClasses: classes, uploadedJsonObjects: uploadedJsonObjects.length }))
