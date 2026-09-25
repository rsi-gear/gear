import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FileArtifactStore } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import { implementationClosureDigest } from '../data/identity.js'
import type { ArtifactRef, OperationEnvelope } from '../contracts.js'
import { assertJson, jsonDigest, type JsonValue } from '../schema.js'
import { digestJson } from '../../training/digest.js'
import { parseContentRef, parseModelTrainingSpec, parseModelVersion, parseTrainingRequest, parseTrainingStatus, requireContract } from '../../training/schema.js'
import { validateTrainingReference, validateTrainingResumeCheckpoint } from '../../training/operation-contracts.js'
import { SlimeModelTrainer, NodeSlimeModelTrainer } from '../../training/slime.js'
import type { TrainingContentStore } from '../../training/store.js'
import type * as T from '../../training/types.js'

export const TRAINING_MODEL_BINDING_SCHEMA = 'training.model-binding.v1'
export const TRAINING_HARNESS_BINDING_SCHEMA = 'training.fixed-harness.v1'
export const TRAINING_USAGE_SOURCE = 'training.slime'
export type TrainingModelBinding = { modelRef: T.ContentRef; model: T.ModelVersion }
export type TrainingOperationInput = { plan: T.ModelTrainingSpec; learnerSlot: string; harnessSlot: string }
export type TrainingRequestMapping = { request: T.TrainingRequest; idempotencyKey: string; requestDigest: string; modelBinding: TrainingModelBinding }
export interface TrainingJobLookup {
  identityDigest: string
  /** Null means the backend established that this exact key has not started. Exceptions mean unknown. */
  find(request: T.TrainingRequest, idempotencyKey: string): Promise<T.TrainingStatus | null>
}

export function trainingOperationImplementationDigest(backendIdentityDigest: string): string {
  return implementationClosureDigest(['providers/training', 'providers/model-evaluation',
    '../training/slime', '../training/hitch', '../training/coordinator'], { backendIdentityDigest })
}

function localPythonRuntimeDigest(command: string[]): string {
  requireContract(command.length > 0, 'missing-python-runtime', 'Slime Python command is required')
  const probe = `import importlib.util,importlib.metadata,json,os,sys\ns=importlib.util.find_spec('gear_training')\nassert s and s.submodule_search_locations\nprint(json.dumps({'packageRoot':os.path.realpath(list(s.submodule_search_locations)[0]),'executable':os.path.realpath(sys.executable),'version':sys.version,'distributions':sorted((d.metadata.get('Name',''),d.version) for d in importlib.metadata.distributions())}))`
  const result = spawnSync(command[0]!, [...command.slice(1), '-c', probe], { encoding: 'utf8', timeout: 30_000, maxBuffer: 5_000_000 })
  requireContract(result.status === 0 && !result.error, 'python-runtime-probe-failed', 'cannot inspect installed Slime Python runtime')
  const observed = JSON.parse(result.stdout) as { packageRoot: string; executable: string; version: string; distributions: [string, string][] }
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ executable: observed.executable, version: observed.version, distributions: observed.distributions }))
  hash.update(readFileSync(observed.executable))
  const packageRoot = realpathSync(observed.packageRoot)
  let count = 0
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc')) continue
      const path = join(directory, name); const stat = lstatSync(path)
      requireContract(!stat.isSymbolicLink(), 'python-runtime-symlink', 'installed Slime source must not contain symlinks')
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        requireContract(++count <= 10_000, 'python-runtime-too-large', 'installed Slime package is too large to seal')
        const bytes = readFileSync(path)
        hash.update(relative(packageRoot, path)); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes)
      }
    }
  }
  visit(packageRoot)
  return hash.digest('hex')
}

export async function sealTrainingModelBinding(artifacts: FileArtifactStore, store: TrainingContentStore, modelRef: T.ContentRef): Promise<ArtifactRef> {
  const portable = parseContentRef(modelRef)
  requireContract(portable.uri === `cas:${portable.digest}`, 'nonportable-model-binding', 'model binding requires immutable training CAS')
  const model = parseModelVersion(await store.readJson(portable))
  const value: TrainingModelBinding = { modelRef: portable, model }
  assertJson(value)
  return artifacts.putJson(value as unknown as JsonValue, TRAINING_MODEL_BINDING_SCHEMA)
}

export async function sealTrainingHarnessBinding(artifacts: FileArtifactStore, store: TrainingContentStore, harness: T.ModelTrainingSpec['fixedHarness']): Promise<ArtifactRef> {
  await store.readBytes(harness.manifestRef)
  assertJson({ fixedHarness: harness })
  return artifacts.putJson({ fixedHarness: harness } as unknown as JsonValue, TRAINING_HARNESS_BINDING_SCHEMA)
}

function parseOperationInput(value: JsonValue): TrainingOperationInput {
  requireContract(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-training-operation', 'training input must be an object')
  const fields = value as Record<string, JsonValue>
  requireContract(Object.keys(fields).sort().join(',') === 'harnessSlot,learnerSlot,plan'
    && typeof fields.learnerSlot === 'string' && typeof fields.harnessSlot === 'string',
  'invalid-training-operation', 'training input requires frozen plan and binding slot names')
  return { plan: parseModelTrainingSpec(fields.plan), learnerSlot: fields.learnerSlot, harnessSlot: fields.harnessSlot }
}

export async function resolveFrozenTrainingBindings(input: JsonValue, bindingSetRef: OperationEnvelope['bindingSetRef'], bindings: BindingStore,
  artifacts: FileArtifactStore, store: TrainingContentStore): Promise<{ plan: T.ModelTrainingSpec; modelBinding: TrainingModelBinding }> {
  const { plan, learnerSlot, harnessSlot } = parseOperationInput(input)
  const bound = bindings.read(bindingSetRef)
  const learnerRef = bound.slots[learnerSlot]
  const harnessRef = bound.slots[harnessSlot]
  requireContract(learnerRef?.schemaId === TRAINING_MODEL_BINDING_SCHEMA && harnessRef?.schemaId === TRAINING_HARNESS_BINDING_SCHEMA,
    'training-binding-schema', 'learner and fixed Harness slots require their sealed binding schemas')
  const modelBinding = artifacts.getJson(learnerRef) as unknown as TrainingModelBinding
  requireContract(modelBinding && typeof modelBinding === 'object' && modelBinding.modelRef,
    'invalid-model-binding', 'learner binding must include model and training CAS reference')
  const modelRef = parseContentRef(modelBinding.modelRef)
  requireContract(modelRef.uri === `cas:${modelRef.digest}`, 'nonportable-model-binding', 'learner model must be in training CAS')
  const model = parseModelVersion(modelBinding.model)
  const fromCas = parseModelVersion(await store.readJson(modelRef))
  requireContract(digestJson(model) === digestJson(fromCas), 'model-binding-drift', 'learner binding differs from frozen training CAS')
  const harnessBinding = artifacts.getJson(harnessRef) as unknown as { fixedHarness: T.ModelTrainingSpec['fixedHarness'] }
  requireContract(harnessBinding && digestJson(harnessBinding.fixedHarness) === digestJson(plan.fixedHarness),
    'training-harness-drift', 'fixed Harness binding differs from frozen training plan')
  await validateTrainingReference(store, model, plan.referenceModel)
  for (const ref of [plan.fixedHarness.manifestRef, plan.verifier, plan.trainer.hyperparametersRef,
    ...Object.values(plan.datasets).flatMap(partition => [partition.snapshotRef, ...partition.tasks.flatMap(task => [task.taskRef, task.environmentRef])])]) await store.readBytes(ref)
  return { plan, modelBinding: { modelRef, model } }
}

export async function mapFrozenTrainingRequest(envelope: OperationEnvelope, bindings: BindingStore, artifacts: FileArtifactStore, store: TrainingContentStore): Promise<TrainingRequestMapping> {
  requireContract(envelope.operationId === envelope.idempotencyKey && envelope.inputDigest === jsonDigest(envelope.input),
    'training-operation-identity', 'training operation identity or input digest changed')
  const { plan, modelBinding } = await resolveFrozenTrainingBindings(envelope.input, envelope.bindingSetRef, bindings, artifacts, store)
  const { modelRef, model } = modelBinding
  const gpu = envelope.limits.trainingGpuSeconds
  const tokens = envelope.limits.rolloutTokens
  const resamples = envelope.limits.groupResamples
  requireContract(typeof gpu === 'number' && Number.isFinite(gpu) && gpu > 0 && typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0 && typeof resamples === 'number' && Number.isSafeInteger(resamples) && resamples >= 0,
    'training-reservation', 'training requires GPU seconds, rollout tokens and group-resample reservations')
  requireContract(gpu >= plan.budgets.totalGpuSeconds && tokens >= plan.budgets.maxRolloutTokens
    && resamples >= plan.budgets.maxGroupResamples, 'training-reservation-too-small',
  'operation reservations must cover the complete frozen training request budgets')
  const experimentId = `alg_${digestJson(envelope.campaignId).slice(7, 39)}`
  const trainingRunId = `train_${envelope.operationId.slice(0, 32)}`
  const request = parseTrainingRequest({ schemaVersion: plan.schemaVersion, ...(plan.schemaVersion === 2 ? { deployment: plan.deployment } : {}),
    trainingRunId, experimentId, parentModel: model, parentModelRef: modelRef, referenceModelRef: plan.referenceModel,
    ...(model.trainerCheckpointRef ? { resumeCheckpointRef: model.trainerCheckpointRef } : {}), coldStart: !model.trainerCheckpointRef,
    fixedHarness: plan.fixedHarness, trainDataset: plan.datasets.train, verifier: plan.verifier, trainer: plan.trainer, rollout: plan.rollout,
    trainingDevices: plan.resources.trainingDevices,
    budgets: plan.budgets,
    recipeDigest: digestJson({ trainer: plan.trainer, rollout: plan.rollout, verifier: plan.verifier, referenceModelRef: plan.referenceModel,
      ...(plan.schemaVersion === 2 ? { deployment: plan.deployment } : {}) }), datasetSplitDigest: digestJson(plan.datasets),
  })
  await validateTrainingResumeCheckpoint(store, request)
  return { request, idempotencyKey: envelope.idempotencyKey, requestDigest: digestJson(request), modelBinding }
}

const expectedJobId = (key: string) => `job_${digestJson(key).slice(7, 39)}`

/** Read-only lookup of the original local Slime service's durable identity. */
export function localSlimeJobLookup(trainer: SlimeModelTrainer): TrainingJobLookup {
  const original = readFileSync(trainer.options.configPath)
  const config = JSON.parse(original.toString('utf8')) as { jobsRoot?: unknown }
  requireContract(typeof config.jobsRoot === 'string' && config.jobsRoot.length > 0 && statSync(config.jobsRoot).isDirectory(),
    'invalid-job-config', 'local Slime jobsRoot must exist')
  const jobsRoot = config.jobsRoot
  const runtimeDigest = localPythonRuntimeDigest(trainer.options.python)
  const identityDigest = digestJson({ configDigest: createHash('sha256').update(original).digest('hex'), options: trainer.options, runtimeDigest })
  return { identityDigest, async find(request, key) {
    requireContract(readFileSync(trainer.options.configPath).equals(original), 'job-config-drift', 'local Slime config changed')
    requireContract(localPythonRuntimeDigest(trainer.options.python) === runtimeDigest, 'python-runtime-drift', 'installed Slime Python runtime changed')
    requireContract(statSync(jobsRoot).isDirectory(), 'job-root-unavailable', 'local Slime jobsRoot is unavailable')
    const directory = join(jobsRoot, expectedJobId(key))
    try { requireContract(statSync(directory).isDirectory(), 'job-identity-pending', 'local job path is not a directory') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const identityPath = join(directory, 'identity.json')
    try { statSync(identityPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('job directory exists without committed identity'); throw error }
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { handle?: unknown; keyDigest?: unknown }
    const handle = identity.handle as T.TrainingHandle
    requireContract(identity.keyDigest === digestJson(key) && handle && handle.schemaVersion === 1 && handle.jobId === expectedJobId(key)
      && handle.requestDigest === digestJson(request), 'training-request-drift', 'local job identity differs from frozen request/key')
    return parseTrainingStatus(await trainer.inspect(handle))
  } }
}

/** Uses the model-node's durable training.find, then its episode-aware inspect. */
export function nodeSlimeJobLookup(trainer: NodeSlimeModelTrainer): TrainingJobLookup {
  const transport = trainer.transport
  requireContract(transport.identity, 'node-not-resolved', 'model-node identity must be pinned')
  const identity = transport.identity
  const identityDigest = digestJson({ node: identity, connection: transport.connection })
  return { identityDigest, async find(request, key) {
    await verifyNodeTrainingRuntime(trainer, request)
    const found = await transport.call('training.find', { idempotencyKey: key, requestDigest: digestJson(request) }) as { exists?: unknown; status?: unknown }
    requireContract(typeof found?.exists === 'boolean', 'invalid-job-lookup', 'model node did not establish submission identity')
    if (!found.exists) return null
    const local = parseTrainingStatus(found.status)
    requireContract(local.handle.schemaVersion === 1 && local.handle.jobId === expectedJobId(key) && local.handle.requestDigest === digestJson(request),
      'training-request-drift', 'model-node find returned another request')
    const handle: T.TrainingHandle = { ...local.handle, schemaVersion: 2, node: identity }
    return parseTrainingStatus(await trainer.inspect(handle))
  } }
}

export async function verifyNodeTrainingRuntime(trainer: NodeSlimeModelTrainer, request: T.TrainingRequest): Promise<void> {
  const transport = trainer.transport
  requireContract(request.schemaVersion === 2 && transport.identity && request.deployment.modelRuntime.nodeId === transport.identity.nodeId
    && request.deployment.modelRuntime.generation === transport.identity.generation, 'training-node-drift', 'request belongs to another model-node generation')
  const probe = await transport.call('probe', {}) as { nodeId?: unknown; generation?: unknown; runtimeDigest?: unknown; runtime?: unknown }
  requireContract(probe.nodeId === transport.identity.nodeId && probe.generation === transport.identity.generation
    && probe.runtimeDigest === request.deployment.modelRuntime.runtimeDigest && probe.runtimeDigest === digestJson(probe.runtime),
  'training-node-runtime-drift', 'model-node actual runtime differs from frozen deployment')
}
