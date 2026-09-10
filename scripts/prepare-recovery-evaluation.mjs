// Plan an immutable evaluation of the recovered candidate on the same node.
// This reads actual files/runtime through Hitch; it does not start SGLang.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { jsonProcess } from '../lib/training/process.js'
import { atomicWrite, TrainingContentStore } from '../lib/training/store.js'
import { digestJson } from '../lib/training/digest.js'
import { inferenceCommonDigest } from '../lib/training/hitch.js'

const [root] = process.argv.slice(2); assert(root, 'usage: prepare-recovery-evaluation.mjs INPUT_ROOT')
const read = async n => JSON.parse(await readFile(join(root, n), 'utf8'))
const recovered = await read('recovery/summary.json'); assert.equal(recovered.status, 'passed')
const { request: train } = await read('training-payload.json'), hitch = await read('hitch-controller.json')
const deployment = await read('deployment-template.json'), node = train.deployment.modelRuntime
const store = new TrainingContentStore(join(root, 'controller-content'))
const workspace = join(root, 'independent'); await mkdir(workspace, { recursive: true })
const binding = { schema_version: '2', node_id: node.nodeId, generation: node.generation, runtime_digest: node.runtimeDigest, launcher: 'process' }
const { workspace: _workspace, ...connection } = deployment.nodes[deployment.modelRuntime.nodeRef]
connection.gateway = { localPort: 32012, nodePort: 32012 }
const bindingFile = join(workspace, 'binding.json'), registrationFile = join(workspace, 'registration.json'), snapshotFile = join(workspace, 'snapshot-ref.json')
await atomicWrite(bindingFile, binding); await atomicWrite(registrationFile, { schema_version: '2', binding, connection })
await atomicWrite(snapshotFile, recovered.model.hfSnapshotRef)
const call = args => jsonProcess(hitch.command, ['--root', hitch.root, ...args], undefined, 180_000)
await call(['model-node', 'register', '--file', registrationFile])
const imported = await call(['models', 'add-node', snapshotFile, '--model-node-file', bindingFile, '--name', recovered.model.id.slice(7), '--json'])
const harness = `${train.fixedHarness.adapter}@git+${pathToFileURL(hitch.harnessSourceDirectory).href}#${train.fixedHarness.commit}`
const planned = await call(['local', 'plan', `local/${imported.model_id}`, '--harness', harness,
  '--gpu', train.trainingDevices[0].gpuUuid, '--model-node-file', bindingFile, '--offline', '--json'])
const lock = planned.lock
const options = { command: hitch.command, root: hitch.root, workspace, harnessSourceDirectory: hitch.harnessSourceDirectory,
  python: hitch.python, deployment, modelNode: connection, artifactStorage: 'model-node',
  budgets: { timeoutSeconds: 120, setupTimeoutSeconds: 180, maxConcurrent: 1, maxEpisodeSteps: 16, infrastructureRetries: 0, maxRepairRounds: 0 } }
const request = { schemaVersion: 1, subject: { harnessRef: train.fixedHarness.manifestRef, modelVersionRef: recovered.modelRef, weightsDigest: recovered.model.weightsDigest },
  model: recovered.model, condition: { schemaVersion: 1, partition: 'dev', datasetDigest: train.trainDataset.snapshotRef.digest,
    slots: train.trainDataset.tasks.map(task => ({ taskId: task.id, attempt: 1, environmentDigest: task.environmentRef.digest })),
    verifierDigest: train.verifier.digest, budgetsDigest: digestJson(options.budgets), samplingDigest: digestJson(lock.generation),
    runtimeDigest: inferenceCommonDigest(lock), protocolDigest: digestJson(lock.protocol), tokenizerDigest: recovered.model.tokenizerDigest,
    chatTemplateDigest: recovered.model.chatTemplateDigest, architecture: recovered.model.architecture, dtype: recovered.model.dtype,
    deploymentDigest: digestJson(train.deployment) }, datasetRef: train.trainDataset.snapshotRef, harnessCommit: train.fixedHarness.commit,
  harnessAdapter: train.fixedHarness.adapter, datasetTasks: train.trainDataset.tasks, verifierRef: train.verifier,
  evaluationDevices: [train.trainingDevices[0].gpuUuid], deployment: train.deployment }
const capture = await read('recovery/training-capture-audit.json')
assert.equal(digestJson(capture), recovered.captureAuditDigest)
assert.deepEqual(capture.checkpointRef, recovered.checkpointRef)
const trainingRunIds = capture.updates.flatMap(update => update.samples.map(sample => sample.runId))
assert.equal(new Set(trainingRunIds).size, train.trainer.updatesPerCandidate * train.trainer.rolloutBatchSize * train.rollout.groupSize)
await atomicWrite(join(root, 'evaluation-input.json'), { kind: 'gear-independent-model-diagnostic', validated: false,
  seconds: 600, storeRoot: store.root, request, options, plannedLock: lock, trainingRunIds })
console.log(JSON.stringify({ modelId: imported.model_id, inferenceId: lock.inference_id, trainingRunIds }))
