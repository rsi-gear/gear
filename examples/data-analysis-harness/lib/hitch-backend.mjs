import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { command } from '../../kaggle-titanic/common.mjs'
import { assert, digest, seal, sha, sourcePath, validateCheckpoint, validateSolution, verify, zeroCost } from './contracts.mjs'
import { atomicJson, json, locked } from './store.mjs'
import { validateRequest } from './schemas.mjs'
import { metricName, utility } from './metrics.mjs'
import { fileHash, treeManifest } from './mlebench.mjs'
import { cvSelection } from './validation.mjs'

async function writeImmutableInput(path, bytes) {
  try { await writeFile(path, bytes, { mode: 0o444, flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await lstat(path)
    assert(existing.isFile() && existing.nlink === 1 && (await readFile(path)).equals(bytes), 'materialized input changed')
  }
}

export async function executionBinding(config) {
  const files = { train: config.train, predict: config.predict, ...(config.expected ? { expected: config.expected } : {}),
    producer: join(config.hitchRepository, 'benchmark-packages/kaggle/analysis.mjs'),
    verifier: join(config.hitchRepository, 'benchmark-packages/kaggle/runtime/analysis-verify.py'),
    schema: join(config.hitchRepository, 'benchmark-packages/kaggle/analysis-contracts/schemas.mjs'),
    ...(config.publicDirectory ? { scoring: join(config.hitchRepository, 'benchmark-packages/kaggle/runtime/scoring.py') } : {}) }
  return seal({ protocol: 'analysis-execution-binding@1', files: Object.fromEntries(await Promise.all(Object.entries(files)
    .map(async ([name, path]) => [name, await fileHash(path)]))), executorCommit: config.executorCommit,
    ...(config.publicDirectory ? { publicTreeDigest: digest(await treeManifest(config.publicDirectory)) } : {}),
    runtimeDigest: config.runtimeDigest, model: config.model, platform: config.platform, baseImage: config.baseImage })
}

export async function refitBinding(config) {
  return seal({ protocol: 'analysis-refit-input-binding@1',
    inputs: { trainDigest: await fileHash(config.refit.train), predictDigest: await fileHash(config.refit.predict) },
    predictIdsDigest: digest(config.refit.predictIds) })
}

/** Only public Hitch commands and resource APIs; no Hitch CAS/layout access. */
export class HitchBackend {
  constructor(store, config) { this.store = store; this.config = config }
  async hitch(args, { signal, executor = false } = {}) {
    const c = this.config
    return JSON.parse(await command(executor ? c.executorExecutable : c.executable, ['--root', c.root, ...args], {
      cwd: c.workDirectory, env: { ...process.env, GEAR_HITCH_EXECUTABLE: c.executorExecutable }, signal,
    }))
  }
  async admit(plan) {
    const caps = await this.hitch(['capabilities', '--json'], { executor: true })
    assert(caps.run_output_artifacts === '1' && caps.sealed_source_execution === '1', 'matching Hitch output artifacts and sealed-source capability required')
    assert(plan.runtimeDigest === this.config.runtimeDigest, 'runtime differs from plan')
    if (plan.budget.tokens !== null || plan.budget.requests !== null) throw new Error('This carrier requires the explicitly unbounded model profile (tokens:null, requests:null); hard provider admission is not certified')
    assert(this.config.executorCommit && this.config.model === plan.model, 'executor/model not frozen')
    const current = await executionBinding(this.config), frozen = await this.store.load('bindings', 'execution')
    assert(frozen?.digest === current.digest, 'evaluation data or producer/scorer changed; prepare a new execution contract')
    this.bindingDigest = frozen.digest
    for (const [name, expected] of Object.entries(plan.task.inputs)) {
      if (name === 'trainDigest' || name === 'predictDigest') assert(sha(await readFile(this.config[name === 'trainDigest' ? 'train' : 'predict'])) === expected, 'task inputs changed')
    }
  }
  async materialize(request, checkpoint) {
    validateRequest(request); verify(request)
    const id = request.digest.slice(7), existing = await this.store.load('tasks', id)
    if (existing) return existing
    const directory = join(this.store.root, 'task-inputs', id)
    await mkdir(join(directory, 'objects'), { recursive: true })
    await atomicJson(join(directory, 'request.json'), request)
    const sourceConfig = request.protocol === 'analysis-refit-request@1' ? this.config.refit : this.config
    await copyFile(sourceConfig.train, join(directory, 'train.csv')); await copyFile(sourceConfig.predict, join(directory, 'predict.csv'))
    for (const file of request.task.publicFiles ?? []) {
      sourcePath(file.path)
      const source = join(this.config.publicDirectory, file.path), destination = join(directory, 'public', file.path)
      assert(await fileHash(source) === file.digest, 'public MLE-bench asset changed')
      const bytes = await readFile(source)
      assert(bytes.length === file.bytes && sha(bytes) === file.digest, 'public MLE-bench asset changed')
      await mkdir(join(destination, '..'), { recursive: true }); await writeImmutableInput(destination, bytes)
    }
    if (checkpoint) {
      validateCheckpoint(checkpoint); await this.store.verifySources(checkpoint)
      await atomicJson(join(directory, 'checkpoint.json'), checkpoint)
      await atomicJson(join(directory, 'validation.json'), request.roundValidation ?? this.config.validationPlan)
      for (const id of new Set(checkpoint.history.flatMap(e => [e.execution.oofDigest, e.execution.predictionsDigest, ...(e.analysis?.artifacts ?? []).map(a => a.digest), e.analysis?.pluginCache?.digest]).filter(Boolean)))
        await writeImmutableInput(join(directory, 'objects', id.slice(7)), await this.store.bytes(id))
    }
    for (const s of checkpoint?.solutions ?? [request.solution]) {
      validateSolution(s)
      for (const f of s.files) await writeImmutableInput(join(directory, 'objects', f.digest.slice(7)), await this.store.bytes(f.digest))
    }
    const { produceAnalysisTask } = await import(pathToFileURL(join(this.config.hitchRepository, 'benchmark-packages/kaggle/analysis.mjs')))
    const out = join(this.store.root, 'datasets', id)
    await mkdir(join(this.store.root, 'datasets'), { recursive: true })
    const task = await produceAnalysisTask({ root: this.config.root, out, candidate: directory,
      expected: checkpoint || request.protocol === 'analysis-refit-request@1' ? null : this.config.expected,
      baseImage: this.config.baseImage, platform: this.config.platform, request,
      timeoutSeconds: Math.max(1, Math.floor(request.allowance.wallSeconds)) })
    await this.store.save('tasks', id, task)
    return task
  }
  async execute(request, checkpoint, { signal } = {}) {
    const id = request.digest.slice(7), task = await this.materialize(request, checkpoint), research = !!checkpoint
    let operation = await this.store.load('executions', id), first = false
    if (!operation) {
      operation = { requestDigest: request.digest, evalId: `eval_${randomUUID().replaceAll('-', '')}`, task, status: 'reserved' }
      await this.store.save('executions', id, operation); first = true
    } else if (operation.status === 'reserved') {
      try { await this.hitch(['eval', 'inspect', operation.evalId, '--json'], { executor: true, signal }) }
      catch (error) {
        // Public proof of non-admission permits retrying the SAME eval ID.
        // Ambiguous transport/infrastructure errors never grant a new sample.
        if (error.exitCode === 3 && /eval(?:uation)? not found/i.test(error.message)) first = true
        else throw error
      }
    }
    assert(operation.requestDigest === request.digest && operation.task.datasetDigest === task.datasetDigest, 'execution changed')
    if (first) {
      const commit = research ? request.harness.commit : this.config.executorCommit
      const repository = research ? this.config.targetRepository : this.config.executorRepository
      const harness = `${research ? 'deepseek' : 'sealed-python'}@git+${pathToFileURL(repository).href}#${commit}`
      const args = ['eval', 'run', '--eval-id', operation.evalId, '--dataset', task.path, '--harness', harness,
        ...(research ? ['--model', this.config.model] : ['--no-model']), '--attempts', '1', '--max-concurrent', '1',
        '--infrastructure-retries', '0', '--timeout', `${Math.max(1, Math.floor(request.allowance.wallSeconds * 1000))}ms`,
        '--setup-timeout', `${this.config.setupTimeoutMs ?? 300000}ms`, '--output', 'json']
      if (research) for (const name of this.config.passEnv ?? []) args.push('--pass-env', name)
      // Reserve the eval ID before submission. A lost reply is recovered by
      // inspection; no automatic fresh sample or free retry is possible.
      await this.hitch(args, { signal, executor: !research })
    }
    const inspection = await this.hitch(['eval', 'inspect', operation.evalId, '--json'], { executor: true, signal })
    assert(inspection.schema_version === '1' && inspection.eval_id === operation.evalId, 'evaluation identity mismatch')
    if (!inspection.result) throw new Error(`evaluation pending: ${operation.evalId}; inspect or use Hitch recovery, never resubmit`)
    const trials = inspection.result.trials
    assert(trials?.length === 1, 'one physical experiment per task required')
    const trial = trials[0]
    assert(trial.task_id === task.taskId && trial.run_id && trial.observation_status === 'valid', `unavailable trusted experiment: ${operation.evalId}`)
    const { parseRunOutputManifest, parseRunOutputExport } = await import('../../../lib/evaluator/run-artifacts.js')
    const manifest = parseRunOutputManifest(await this.hitch(['runs', 'artifacts', 'list', trial.run_id, '--json'], { executor: true, signal }),
      { runId: trial.run_id, evalId: operation.evalId, attempt: 1, harnessCommit: research ? request.harness.commit : this.config.executorCommit,
        taskId: task.taskId, taskDigest: task.taskDigest })
    const destination = join(this.store.root, 'exports', trial.run_id)
    await mkdir(join(this.store.root, 'exports'), { recursive: true })
    parseRunOutputExport(await this.hitch(['runs', 'artifacts', 'export', trial.run_id, '--manifest-digest', manifest.digest,
      '--out', destination, '--json'], { executor: true, signal }), manifest, destination)
    for (const entry of manifest.entries) {
      const bytes = await readFile(join(destination, entry.path))
      assert(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'exported object changed')
      if (entry.path.startsWith('output/objects/')) assert(await this.store.putBytes(bytes) === `sha256:${entry.path.slice('output/objects/'.length)}`, 'source object name mismatch')
    }
    const output = verify(await json(join(destination, 'output/receipt.json')))
    assert(output.requestDigest === request.digest && output.runId === trial.run_id, 'receipt run/request mismatch')
    const verifier = await this.hitch(['verifier', 'inspect', trial.run_id, '--json'], { executor: true, signal })
    assert(verifier.run_id === trial.run_id && verifier.parent?.eval_id === operation.evalId && verifier.parent?.attempt === 1
      && verifier.observation?.status === 'valid' && verifier.verifier?.status === 'complete', 'verifier provenance unavailable')
    const rewards = verifier.verifier.result?.rewards
    assert(rewards && rewards.total_score === trial.scores.total_score, 'verifier/trial score mismatch')
    operation = { ...operation, status: 'complete', runId: trial.run_id, outputManifestDigest: manifest.digest, destination, trial, output,
      rewards, verifierDigest: verifier.verifier.result_sha256 }
    await this.store.save('executions', id, operation)
    return operation
  }
  async rollout(request, checkpoint, options) {
    const operation = await this.execute(request, checkpoint, options)
    assert(operation.output.protocol === 'analysis-rollout-output@1', 'wrong rollout output')
    const { digest: _, protocol: _protocol, ...body } = operation.output
    return seal({ ...body, protocol: 'analysis-rollout-receipt@1', outputManifestDigest: operation.outputManifestDigest })
  }
  async trajectoryPage(runId, query = {}, { signal } = {}) {
    const index = await this.store.load('seed-runs', runId)
    assert(index?.childRuns.includes(runId), 'trajectory outside authorized research runs')
    const types = query.types ?? ['tool/call', 'tool/result', 'user/message']
    assert(types.length && types.every(t => ['tool/call', 'tool/result', 'user/message', 'request/header'].includes(t)), 'only observable evidence may be queried')
    let canonical = query.canonicalDigest
    if (!canonical) {
      const overview = await this.hitch(['trajectory', 'project', runId, '--profile', 'analysis', '--max-bytes', '16384', '--json'], { executor: true, signal })
      canonical = overview.source.canonical_sha256
    }
    assert(/^sha256:[a-f0-9]{64}$/.test(canonical), 'canonical trajectory digest required')
    if (query.field) assert(query.seqStart === query.seqEnd && Number.isSafeInteger(query.seqStart), 'field retrieval requires one exact event')
    const args = ['trajectory', 'events', runId, '--canonical-sha256', canonical, '--types', types.join(','), '--max-bytes', '32768', '--limit', '20', '--json']
    for (const [name, value] of [['seq-start', query.seqStart], ['seq-end', query.seqEnd], ['field', query.field], ['cursor', query.cursor]])
      if (value !== undefined) args.push(`--${name}`, String(value))
    const page = await this.hitch(args, { executor: true, signal })
    assert(page.run_id === runId && page.canonical_sha256 === canonical, 'trajectory source changed')
    assert(page.events.every(e => types.includes(e.type)), 'requested field is outside observable evidence')
    return page
  }
  async resolveSeedChild(anchorRunId, runId, provider, signal) {
    signal.throwIfAborted()
    const anchor = await this.store.load('seed-runs', anchorRunId), child = await this.store.load('seed-runs', runId)
    if (!anchor || !child || anchor.cellKey !== child.cellKey) return undefined
    const cell = await this.store.load('cells', anchor.cellKey)
    if (!cell || cell.partition !== 'seed' || cell.cell.evidenceRef !== anchorRunId
      || !await provider.verifyCell(cell.cell, cell.cell.identity)) return undefined
    const state = await this.store.load('sequences', cell.plan.digest.slice(7))
    const step = state?.steps.find(s => s.runId === runId)
    if (!step || !cell.receipt.steps.some(s => s.runId === runId && s.receiptDigest === step.digest)) return undefined
    const operation = await this.store.load('executions', step.requestDigest.slice(7))
    assert(operation?.status === 'complete' && operation.runId === runId, 'seed child execution is unavailable')
    signal.throwIfAborted()
    return { evalId: operation.evalId, trial: { taskName: cell.plan.task.taskId, runId, status: 'completed',
      rewards: operation.rewards, attempt: 1, ...(operation.trial.trial_name ? { trialName: operation.trial.trial_name } : {}) } }
  }
  async deliver(request, options) {
    const operation = await this.execute(request, null, options), output = operation.output
    assert(output.protocol === 'analysis-execution-receipt@1' && output.solutionDigest === request.solution.digest && output.modelRequests === 0, 'sealed executor identity mismatch')
    const valid = operation.rewards.valid_output === 1, deployment = request.protocol === 'analysis-refit-request@1'
    const generic = request.task.protocol !== 'analysis-task@1', metric = metricName(request.task)
    const score = valid && !deployment ? generic ? operation.rewards.task_score : operation.rewards.accuracy : null
    assert(!valid || deployment || typeof score === 'number' && Number.isFinite(utility(metric, score)), 'missing external metric score')
    const accuracy = metric === 'accuracy' ? score : null
    return seal({ protocol: 'analysis-delivery@1', requestDigest: request.digest, solutionDigest: request.solution.digest,
      runId: operation.runId, outputManifestDigest: operation.outputManifestDigest, executorCommit: this.config.executorCommit,
      status: valid ? 'completed' : 'candidate_failed', modelRequests: 0,
      quality: valid ? deployment ? 1 : utility(metric, score) : 0, accuracy,
      ...(generic ? { metric, score } : {}),
      ...(request.solution.protocol === 'analysis-solution@2' ? { resolvedPipelineDigest: output.resolvedPipelineDigest, fits: output.fits, fitCalls: output.fitCalls, searchCalls: output.searchCalls } : {}),
      predictionsDigest: output.predictionsDigest, failedAttempts: operation.failedAttempts ?? [],
      cost: { ...zeroCost(), cpuSeconds: output.cpuSeconds + (operation.failedAttempts ?? []).reduce((n, a) => n + a.reservedCpuSeconds, 0) } })
  }
  /** Explicit, bounded infrastructure recovery; never repairs a valid score or resamples a model. */
  async repairSealed(request, reason) {
    verify(request)
    assert(['analysis-delivery-request@1', 'analysis-audit-request@1', 'analysis-refit-request@1'].includes(request.protocol), 'only fixed no-model execution can be recovered here')
    assert(typeof reason === 'string' && reason.trim().length > 0, 'recovery reason required')
    const id = request.digest.slice(7)
    return locked(this.store.path('locks', `repair-${id}`), async () => {
      const operation = await this.store.load('executions', id)
      assert(operation && operation.status !== 'complete' && !(operation.failedAttempts?.length), 'operation is complete or its recovery allowance is spent')
      const inspection = await this.hitch(['eval', 'inspect', operation.evalId, '--json'], { executor: true })
      const result = inspection.result, trial = result?.trials?.[0]
      assert(result?.status === 'failed' && result.trials.length === 1 && trial.observation_status === 'invalid'
        && trial.invalid_reason === 'infrastructure_failure', 'recovery requires certified infrastructure failure; valid outcomes and cancellations cannot be retried')
      const reservedCpuSeconds = Math.min(600, request.allowance.cpuSeconds)
      assert(request.allowance.cpuSeconds >= reservedCpuSeconds + 1, 'insufficient remaining execution budget for recovery')
      const failedAttempt = { evalId: operation.evalId, runId: trial.run_id, reason, resultDigest: digest(result),
        reservedCpuSeconds, accounting: 'conservative-upper-bound', recoveredAt: new Date().toISOString() }
      await this.store.save('executions', id, { requestDigest: request.digest, task: operation.task,
        evalId: `eval_${randomUUID().replaceAll('-', '')}`, status: 'reserved', failedAttempts: [failedAttempt] })
      return failedAttempt
    })
  }
  async verifyReceipt(receipt) {
    verify(receipt)
    if (receipt.delivery.protocol === 'analysis-cv-selection@1') {
      const state = await this.store.load('sequences', receipt.planDigest.slice(7))
      assert(state && cvSelection(state.plan, state.steps, receipt.selections[4].incumbentSolutionDigest).digest === receipt.delivery.digest,
        'CV selection differs from the sealed experiment evidence')
      assert(receipt.total_score === receipt.delivery.quality, 'CV sequence score changed')
    }
    for (const step of [...receipt.steps, ...(receipt.delivery.runId ? [{ runId: receipt.delivery.runId, outputManifestDigest: receipt.delivery.outputManifestDigest }] : [])]) {
      const m = await this.hitch(['runs', 'artifacts', 'list', step.runId, '--json'], { executor: true })
      assert(m.digest === step.outputManifestDigest && m.run_id === step.runId, 'required artifacts unavailable or changed')
    }
    await this.store.verifySources(validateCheckpoint(await this.store.get(receipt.checkpointRef)))
    return true
  }
  async cancel(request) {
    if (!request) return
    const op = await this.store.load('executions', request.digest.slice(7))
    if (op && op.status !== 'complete') await this.hitch(['eval', 'cancel', op.evalId, '--json'], { executor: true })
  }
}
