/** Controller bridge for Python-owned stages, using existing node RPC and CAS. */
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { uploadStageSnapshot } from './stage-artifacts.js'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { parseContentRef, parsePolicyLease, requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore } from './store.js'
import { ModelNodeTransport } from './transport.js'
import type { AgentStageConfig, DatasetPartition, PolicyLease, TrainingHandle, TrainingRequestV2 } from './types.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => { requireContract(!!v && typeof v === 'object' && !Array.isArray(v), 'invalid-stage-data', 'expected stage object'); return v as Json }
const same = (a: unknown, b: unknown) => digestJson(a) === digestJson(b)
interface StageEntry { cancelRequested?: boolean; id: string; intent: Json; lease: PolicyLease; result: Json | null }
interface StageOptions { python: string[]; workspace: string }

export function launchStageWorker(command: string[], args: string[], payload: unknown, log: string): void {
  const fd = openSync(log, 'a', 0o600)
  try {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { detached: true, stdio: ['pipe', fd, fd] })
    child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(payload)); child.unref()
    child.on('error', () => { /* The durable launch intent is retried after ownership inspection. */ })
  } finally { closeSync(fd) }
}

export class TrainingStageCoordinator {
  constructor(readonly store: TrainingContentStore, readonly transport: ModelNodeTransport, readonly options: StageOptions,
    private readonly invoke = jsonProcess, private readonly launch = launchStageWorker) {}

  async reconcile(handle: TrainingHandle, request: TrainingRequestV2, cancel: boolean): Promise<{ pending: boolean; tasks: Map<string, DatasetPartition['tasks']> }> {
    const tasks = new Map<string, DatasetPartition['tasks']>()
    if (!request.stages) return { pending: false, tasks }
    const response = object(await this.transport.call('training.stages.list', { handle }))
    requireContract(Array.isArray(response.entries), 'invalid-stage-data', 'node stages must be an array')
    let pending = false
    for (const raw of response.entries) {
      const entry = raw as StageEntry; const intent = object(entry.intent); const lease = parsePolicyLease(entry.lease)
      requireContract(entry.id === digestJson(intent) && intent.trainingRunId === request.trainingRunId && intent.schemaVersion === 1,
        'stage-input-drift', 'stage intent differs from its frozen job')
      const config = (intent.stage === 'task-source' ? request.stages.taskSource : request.stages.datasetBuilder) as AgentStageConfig | undefined
      requireContract(['task-source', 'dataset-builder'].includes(String(intent.stage)) && config && same(config, intent.config)
        && lease.trainingRunId === request.trainingRunId && same(intent.weightsRef, lease.synchronizedWeightsRef),
      'stage-config-drift', 'node stage configuration or behavior weights are unauthorized')
      const directory = join(this.options.workspace, 'training-stages', handle.jobId, entry.id.slice(7))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const execution = join(directory, digestJson(lease).slice(7))
      await mkdir(execution, { recursive: true, mode: 0o700 })
      const responseFile = join(execution, 'response.json'), launchFile = join(execution, 'launch.json')
      const workerArgs = ['-m', 'gear_training.stages', '--store-root', this.store.root, '--workspace', directory, '--execution-root', execution, '--response-file', responseFile]
      const stopped = cancel || entry.cancelRequested === true || lease.state !== 'serving' || Date.parse(lease.expiresAt) <= Date.now()
      if (stopped) {
        if (entry.result?.outcome === 'completed' && intent.stage === 'task-source') {
          const payloadRef = parseContentRef(intent.payloadRef)
          await this.transport.download(this.store, payloadRef)
          const payload = object(await this.store.readJson(payloadRef)), sealed = object(entry.result.result)
          requireContract(sealed.inputDigest === digestJson({ schemaVersion: 1, stage: intent.stage, config, payloadDigest: digestJson(payload) }),
            'stage-result-drift', 'cleanup task manifest must retain its exact sealed input')
          tasks.set(lease.batchId, await this.authorizeTasks(request, sealed, intent))
        }
        if (!entry.result) await this.invoke(this.options.python, [...workerArgs, '--stop'], undefined, 30_000)
        continue
      }
      const payloadRef = parseContentRef(intent.payloadRef)
      await this.transport.download(this.store, payloadRef)
      const payload = object(await this.store.readJson(payloadRef))
      requireContract(payload.trainingRunId === request.trainingRunId, 'stage-input-drift', 'stage payload belongs to another training run')
      if (intent.stage === 'task-source') requireContract(same(payload.tasks, request.trainDataset.tasks)
        && same(payload.behaviorPolicyRef, intent.weightsRef) && Number.isSafeInteger(payload.rolloutId)
        && payload.maxTasks === request.trainer.rolloutBatchSize + request.budgets.maxGroupResamples,
      'stage-input-drift', 'task source inputs must be the frozen train pool and current weights')
      if (entry.result?.outcome === 'completed') {
        const sealed = object(entry.result.result)
        requireContract(sealed.inputDigest === digestJson({ schemaVersion: 1, stage: intent.stage, config, payloadDigest: digestJson(payload) }), 'stage-result-drift', 'cached stage output must retain its exact input')
        if (intent.stage === 'task-source') tasks.set(lease.batchId, await this.authorizeTasks(request, sealed, intent))
        continue
      }
      const allowed = object(await this.transport.call('training.stages.inputs', { handle, id: entry.id }))
      requireContract(Array.isArray(allowed.refs), 'invalid-stage-inputs', 'stage input closure must contain original native receipt refs')
      for (const ref of allowed.refs) await this.transport.download(this.store, parseContentRef(ref))
      let result: Json | undefined = entry.result?.outcome === 'completed' ? entry.result : undefined, launched: Json | undefined
      try { result ??= object(JSON.parse(await readFile(responseFile, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      try { launched = object(JSON.parse(await readFile(launchFile, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (launched && !same(launched.lease, lease)) {
        await this.invoke(this.options.python, [...workerArgs, '--stop'], undefined, 30_000)
        if (result?.outcome !== 'completed') { await rm(responseFile, { force: true }); result = undefined }
        await rm(launchFile, { force: true }); launched = undefined
      }
      if (!result) {
        if (launched && Date.now() - Number(launched.at) > 30_000) {
          const worker = object(await this.invoke(this.options.python, [...workerArgs, '--inspect'], undefined, 30_000))
          if (worker.alive !== true) { await rm(launchFile, { force: true }); launched = undefined }
        }
        if (!launched) {
          await atomicWrite(launchFile, { lease, at: Date.now() })
          this.launch(this.options.python, workerArgs, { stage: intent.stage, config, payload }, join(directory, 'worker.log'))
        }
        pending = true; continue
      }
      result = entry.result?.outcome === 'completed' ? entry.result : result
      if (result.outcome === 'completed') {
        const sealed = object(result.result)
        requireContract(sealed.inputDigest === digestJson({ schemaVersion: 1, stage: intent.stage, config, payloadDigest: digestJson(payload) }),
          'stage-result-drift', 'worker result is not bound to this exact stage input')
        if (intent.stage === 'task-source') tasks.set(lease.batchId, await this.authorizeTasks(request, sealed, intent))
        // Opt-in generated outputs are bounded portable provenance. Snapshot
        // file bytes are opaque; JSON files never become dependency roots.
        const snapshotRef = parseContentRef(sealed.snapshotRef)
        await uploadStageSnapshot(this.transport, this.store, snapshotRef)
        for (const ref of [parseContentRef(sealed.inputRef), parseContentRef(sealed.outputRef), parseContentRef(sealed.snapshotRef), parseContentRef(object(sealed.runner).logRef)]) await this.transport.upload(this.store, ref)
        if (intent.stage === 'task-source') {
          for (const task of tasks.get(lease.batchId)!) {
            await this.transport.upload(this.store, task.taskRef)
            await this.transport.upload(this.store, task.environmentRef)
          }
        }
      } else requireContract(result.outcome === 'infra-error', 'invalid-stage-result', 'worker returned unknown outcome')
      if (!entry.result) await this.transport.call('training.stages.result', { handle, id: entry.id, lease, result })
    }
    return { pending, tasks }
  }

  private async authorizeTasks(request: TrainingRequestV2, result: Json, intent: Json): Promise<DatasetPartition['tasks']> {
    const output = object(await this.store.readJson(parseContentRef(result.outputRef)))
    requireContract(Array.isArray(output.tasks) && output.tasks.length > 0
      && output.tasks.length <= request.trainer.rolloutBatchSize + request.budgets.maxGroupResamples,
    'invalid-generated-tasks', 'generated task manifest is empty or exceeded its budget')
    requireContract(request.generatedTaskExclusionRef, 'missing-task-exclusions', 'generated task source requires controller split exclusions')
    // Private exclusions stay in the controller CAS and never enter agent inputs.
    const exclusions = await this.store.readJson<{ ids: string[]; families: string[]; taskDigests: string[]; fingerprints: string[]; instructions: string[] }>(request.generatedTaskExclusionRef)
    const ids = new Set<string>(); const tasks = output.tasks as DatasetPartition['tasks']
    for (const task of tasks) {
      const source = request.trainDataset.tasks.find(source => source.family === task.family)
      requireContract(source && typeof task.id === 'string' && !!task.id && !ids.has(task.id)
        && !exclusions.ids.includes(digestJson(task.id)) && !exclusions.families.includes(digestJson(task.family))
        && !exclusions.taskDigests.includes(task.taskRef.digest), 'generated-task-leakage', 'generated task collided with a private partition or unauthorized family')
      ids.add(task.id)
      const manifest = await this.store.readJson<{ format: string; name: string; files: { path: string; sha256: string }[] }>(task.taskRef)
      requireContract(manifest.format === 'harbor-dataset' && manifest.name === task.id && Array.isArray(manifest.files)
        && !exclusions.fingerprints.includes(digestJson(manifest.files.map(file => file.sha256).sort()))
        && !manifest.files.some(file => file.path.endsWith('instruction.md') && exclusions.instructions.includes(file.sha256)),
      'generated-task-leakage', 'generated task content collided with a private task')
      const environment = object(await this.store.readJson(task.environmentRef))
      requireContract(environment.kind === 'generated-task-environment' && environment.binding === 'canonical-after-sealed-dispatch'
        && environment.taskSnapshotDigest === task.taskRef.digest
        && request.trainDataset.tasks.some(source => source.family === task.family && same(source.environmentRef, environment.sourceEnvironmentRef)),
      'generated-environment-drift', 'generated environment descriptor must bind its actual snapshot and authorized source policy')
    }
    return tasks
  }
}
