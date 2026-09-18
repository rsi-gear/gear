// Freeze CPU canary identities before starting any GPU rental.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { jsonProcess } from '../lib/training/process.js'
import { execFileSync } from 'node:child_process'

const [canaryRoot, output, hitchCheckout, controllerPython, sshAlias, nodeWorkspace] = process.argv.slice(2)
assert(canaryRoot && output && hitchCheckout && controllerPython && sshAlias && nodeWorkspace,
  'usage: prepare-recovery-inputs.mjs CANARY_ROOT OUTPUT HITCH_CHECKOUT CONTROLLER_PYTHON SSH_ALIAS NODE_WORKSPACE')
await mkdir(output, { recursive: true })
const summary = JSON.parse(await readFile(join(canaryRoot, 'summary.json'), 'utf8'))
assert.equal(summary.status, 'passed'); assert.equal(summary.cleanup_proven, true)
const command = [process.execPath, join(hitchCheckout, 'dist/bin/hitch.js')]
const root = join(canaryRoot, 'controller')
const inspected = await jsonProcess(command, ['--root', root, 'runs', 'inspect', summary.run_id, '--json'])
assert.equal(inspected.record_status, 'valid')
const record = inspected.record
assert.equal(record.observation.status, 'valid')
const store = new TrainingContentStore(join(output, 'controller-content'))
const python = ['env', `PYTHONPATH=${resolve('python')}`, controllerPython]
const dataset = await jsonProcess(python, ['-m', 'gear_training.artifacts', 'seal-dataset', '--store-root', store.root], { directory: join(canaryRoot, 'dataset') })
const environmentRef = await store.putJson({ hitchEnvironmentIdentity: record.protocol.environment_identity,
  taskDigest: record.context.task_digest, verifierIdentity: record.context.verifier_identity })
const manifestRef = await store.putJson({ schemaVersion: 1, hitch: { harnessId: record.harness.harness_id,
  revisionIdentity: record.harness.revision_identity, artifactId: record.harness.artifact_id } })
const source = join(canaryRoot, 'training-source')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
assert.equal(record.harness.requested_ref, `training-tool@commit:${commit}`)
const verifier = await store.putJson({ schemaVersion: 1, identity: record.context.verifier_identity,
  result: JSON.parse(await readFile(join(root, 'runs', summary.run_id, 'verifier/result.json'), 'utf8')) })
await atomicWrite(join(output, 'task-inputs.json'), { fixedHarness: { adapter: 'training-tool', commit, manifestRef },
  trainDataset: { snapshotRef: dataset.snapshotRef, tasks: [{ id: record.context.task_id, family: 'two-tools', taskRef: dataset.snapshotRef, environmentRef }], exactDataAuthorized: true }, verifier })
const deployment = { schemaVersion: 2, taskExecution: { placement: 'local', provider: 'local-docker' },
  modelRuntime: { nodeRef: sshAlias, launcher: 'process' }, gpuScheduling: { actorRollout: 'colocated', trainEvaluation: 'sequential' },
  nodes: { [sshAlias]: { transport: { type: 'ssh', host: sshAlias }, workspace: nodeWorkspace,
    python: [join(nodeWorkspace, 'python-node')], configPath: join(nodeWorkspace, 'node.json'), gateway: { localPort: 32011, nodePort: 32011 } } } }
const hitch = { command, root, workspace: join(output, 'episodes'), harnessSourceDirectory: source, python, episodeTimeoutSeconds: 120, deployment }
await atomicWrite(join(output, 'hitch-controller.json'), hitch)
await atomicWrite(join(output, 'deployment-template.json'), deployment)
await atomicWrite(join(output, 'cpu-baseline.json'), { summary, record })
console.log(JSON.stringify({ output, dataset: dataset.snapshotRef, commit, runId: record.run_id }))
