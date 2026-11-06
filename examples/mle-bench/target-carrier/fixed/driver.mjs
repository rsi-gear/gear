import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { decodeOof } from './oof.mjs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assert, digest, seal, sha, sourcePath, validateCheckpoint, validCandidate, verify, zeroCost, defaultBudget } from './lib/contracts.mjs'
import { atomicJson } from './lib/store.mjs'
import { Budget } from './lib/budget.mjs'
import { validateRequest } from './lib/schemas.mjs'
import { verifyHarness } from './integrity.mjs'
import { internalScore, internalQuality } from './lib/metrics.mjs'

export class Driver {
  constructor(repository, { data = '/data', output = '/output', work = '/run/analysis' } = {}) {
    this.repository = repository; this.data = data; this.output = output; this.work = work; this.finished = false
  }
  async initialize() {
    this.harness = await verifyHarness(this.repository)
    this.request = validateRequest(verify(JSON.parse(await readFile(join(this.data, 'request.json'), 'utf8'))))
    this.checkpoint = validateCheckpoint(JSON.parse(await readFile(join(this.data, 'checkpoint.json'), 'utf8')))
    this.plan = JSON.parse(await readFile(join(this.data, 'validation.json'), 'utf8'))
    this.runId = process.env.HITCH_RUN_ID
    assert(/^run_[a-f0-9]{32}$/.test(this.runId ?? ''), 'runtime-assigned Hitch run ID required')
    assert(this.harness.manifest.digest === this.request.harness.manifestDigest, 'harness manifest differs from requested candidate')
    assert(this.checkpoint.digest === this.request.checkpointDigest, 'checkpoint input changed')
    for (const name of ['train', 'predict']) assert(sha(await readFile(join(this.data, `${name}.csv`))) === this.request.task.inputs[`${name}Digest`], 'task data changed')
    if (this.checkpoint.validationPlanDigest) assert(digest(this.plan) === this.checkpoint.validationPlanDigest, 'validation history mismatch')
    await mkdir(this.work, { recursive: true }); await mkdir(this.output, { recursive: true })
    await mkdir(join(this.work, 'workspace'), { recursive: true }); await mkdir(join(this.output, 'objects'), { recursive: true })
    const allowance = this.request.allowance
    this.budget = new Budget({ ...defaultBudget, ...allowance, reserveSeconds: 0, reserveCpuSeconds: 0, reserveTools: 0 })
    this.policyConfig = JSON.parse(await readFile(join(this.harness.root, 'workflows/research/policy.json'), 'utf8'))
    assert(Object.keys(this.policyConfig).sort().join(',') === 'comparisonPrecision,preferCurrentOnTie'
      && this.policyConfig.comparisonPrecision > 0 && typeof this.policyConfig.preferCurrentOnTie === 'boolean', 'invalid policy configuration')
    this.trace = []; this.evaluation = null; this.solution = null; this.selection = undefined; this.claim = null
    await this.persist()
  }
  async persist() {
    await atomicJson(join(this.work, 'budget.json'), this.budget.snapshot())
    if (this.finished) await this.publish()
  }
  async object(bytes) {
    const id = sha(bytes), path = join(this.output, 'objects', id.slice(7))
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o444 }) } catch (e) { if (e.code !== 'EEXIST') throw e; assert(sha(await readFile(path)) === id, 'source object changed') }
    return id
  }
  async worker(job, signal) {
    const id = randomUUID(), path = join(this.work, `${id}.json`)
    await atomicJson(path, job)
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/local/bin/python3', ['-B', join(this.repository, 'fixed/worker.py'), '--job', path],
        { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = '', overflow = false
      const abort = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      child.stdout.on('data', c => { out += c; if (out.length > 8 * 1024 ** 2) { overflow = true; abort() } })
      child.stderr.on('data', c => { err = (err + c).slice(-4000) })
      child.once('error', reject)
      child.once('close', code => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) return reject(signal.reason)
        if (code || overflow) return reject(new Error(`fixed worker failed: ${err}`))
        try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
      })
    })
  }
  async meteredWorker(job, signal) {
    const remaining = this.budget.available(), id = `worker-${randomUUID()}`
    job.cpuSeconds = Math.min(job.cpuSeconds, remaining.cpuSeconds)
    job.wallSeconds = Math.min(job.wallSeconds, remaining.wallSeconds)
    this.budget.reserve(id, { ...zeroCost(), cpuSeconds: job.cpuSeconds }); await this.persist()
    try {
      const result = await this.worker(job, signal)
      this.budget.settle(id, { ...zeroCost(), cpuSeconds: result.cpuSeconds }); await this.persist()
      return result
    } catch (error) {
      if (this.budget.state.reservations[id]) this.budget.settle(id)
      this.infrastructureFailure = true; await this.persist(); throw error
    }
  }
  state(phase) {
    const current = this.checkpoint.currentSolutionDigest
    const history = [...this.checkpoint.history, ...(this.evaluation ? [this.experiment()] : [])]
    const eligible = new Set([...this.request.eligibleSolutionDigests, this.solution?.digest].filter(Boolean))
    return { phase, slotIndex: this.request.slotIndex, task: this.request.task, history,
      currentSolutionDigest: current, eligibleExperiments: history.filter(e => validCandidate(e) && eligible.has(e.sourceDigest)),
      policy: this.policyConfig, policyError: this.policyError ?? null, remaining: this.budget.available() }
  }
  async policy(phase, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await this.policyOnce(phase, signal), action = value.action
        if (phase === 'research') {
          assert(['draft', 'debug', 'improve', 'confirm', 'reuse'].includes(action.action)
            && Object.keys(action).every(k => ['action', 'parentExperimentId'].includes(k)), 'invalid research action')
          assert(action.parentExperimentId === null || this.checkpoint.history.some(e => e.experimentId === action.parentExperimentId), 'unknown research parent')
        } else {
          assert(action.action === 'select' && Object.keys(action).every(k => ['action', 'solutionDigest'].includes(k)), 'invalid selection action')
          const eligible = this.state(phase).eligibleExperiments
          assert(action.solutionDigest === null ? eligible.length === 0 : eligible.some(e => e.sourceDigest === action.solutionDigest), 'ineligible selection')
        }
        return value
      } catch (error) {
        if (this.infrastructureFailure || signal?.aborted) throw error
        this.policyError = String(error.message).slice(0, 2000)
        this.trace.push({ phase, attempt, status: 'policy_error', reason: this.policyError })
      }
    }
    const error = new Error(`policy_error after one correction: ${this.policyError}`); error.code = 'POLICY_ERROR'; throw error
  }
  async policyOnce(phase, signal) {
    const statePath = join(this.work, 'policy-state.json'), runner = join(this.work, 'invoke_policy.py')
    await atomicJson(statePath, this.state(phase))
    await writeFile(runner, "import json,policy,memory\ns=json.load(open('/work/inputs/state.json'))\nr={'action':policy.next_action(s),'memory':memory.summarize_memory(s)}\njson.dump(r,open('/work/scratch/result.json','w'))\n")
    const out = join(this.work, `policy-${randomUUID()}`)
    const result = await this.meteredWorker({ operation: 'script', entrypoint: 'invoke_policy.py',
      files: { 'invoke_policy.py': runner, 'policy.py': join(this.harness.root, 'workflows/research/policy.py'),
        'memory.py': join(this.harness.root, 'workflows/research/memory.py') }, inputs: { 'state.json': statePath },
      argv: [], outputDirectory: out, cpuSeconds: 10, wallSeconds: 20 }, signal)
    assert(result.exitCode === 0 && !result.limit, 'policy_error')
    const value = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'))
    assert(JSON.stringify(value).length <= 32768 && value.action && typeof value.action.action === 'string', 'policy_error')
    this.trace.push({ phase, policyDigest: digest(this.harness.manifest.artifacts.filter(f => f.path.startsWith('workflows/research/'))), decision: value.action })
    return value
  }
  async inspect(signal) {
    const decision = this.initialDecision ?? await this.policy('research', signal)
    assert(['draft', 'debug', 'improve', 'confirm', 'reuse'].includes(decision.action.action), 'policy_error: invalid research action')
    this.action = decision.action
    this.initialDecision = decision
    const guidance = []
    for (const f of this.harness.manifest.artifacts.filter(f => /^(prompts|skills)\//.test(f.path))) {
      const text = await readFile(join(this.harness.root, f.path), 'utf8')
      assert(Buffer.byteLength(text) <= 32768, 'guidance too large')
      guidance.push({ path: f.path, digest: f.digest, text })
    }
    if (!this.guidanceRecorded) { this.trace.push({ phase: 'guidance', loaded: guidance.map(({ path, digest }) => ({ path, digest })) }); this.guidanceRecorded = true }
    const task = this.request.task.protocol === 'analysis-task@2' ? { ...this.request.task,
      predictIds: undefined, predictRows: this.request.task.predictIds.length,
      publicFiles: undefined, publicAssets: { count: this.request.task.publicFiles.length, examples: this.request.task.publicFiles.slice(0, 20) } } : this.request.task
    const validationPlan = this.plan.protocol === 'analysis-validation-plan@2' ? { protocol: this.plan.protocol,
      seed: this.plan.seed, metric: this.plan.metric, trainDigest: this.plan.trainDigest, folds: 5,
      rows: this.plan.foldAssignments.length, digest: this.request.task.validationPlanDigest } : this.plan
    return { task, slotIndex: this.request.slotIndex, startingCheckpointDigest: this.checkpoint.digest,
      currentSolutionDigest: this.checkpoint.currentSolutionDigest, validationPlan, ...decision, guidance,
      visibleSources: this.checkpoint.solutions.map(s => ({ digest: s.digest, files: s.files.map(f => f.path) })), remaining: this.budget.available() }
  }
  async write(path, content, expectedDigest) {
    assert(!this.evaluation, 'source is sealed after evaluation'); sourcePath(path)
    const target = join(this.work, 'workspace', path)
    const before = await readFile(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    assert((before ? sha(before) : null) === expectedDigest, 'workspace precondition failed')
    assert(Buffer.byteLength(content) <= defaultBudget.maxFileBytes, 'file too large')
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, content)
    return { path, digest: sha(content) }
  }
  async read(path, solutionDigest = null) {
    sourcePath(path)
    if (solutionDigest) {
      const solution = this.checkpoint.solutions.find(s => s.digest === solutionDigest)
      const f = solution?.files.find(f => f.path === path); assert(f, 'source outside visible history')
      const bytes = await readFile(join(this.data, 'objects', f.digest.slice(7)))
      assert(sha(bytes) === f.digest, 'history source changed')
      assert(bytes.length <= 65536, 'read exceeds 64 KiB'); return bytes.toString('utf8')
    }
    const text = await readFile(join(this.work, 'workspace', path), 'utf8')
    assert(Buffer.byteLength(text) <= 65536, 'read exceeds 64 KiB'); return text
  }
  async list() { return Object.keys(await this.sourceFiles()) }
  async inspectExperiments(offset = 0) {
    assert(Number.isInteger(offset) && offset >= 0, 'invalid history offset')
    const history = [...this.checkpoint.history, ...(this.evaluation ? [this.experiment()] : [])]
    return { total: history.length, experiments: history.slice(offset, offset + 5) }
  }
  async inspectOof(experimentId, offset = 0) {
    assert(Number.isInteger(offset) && offset >= 0, 'invalid OOF offset')
    const experiment = [...this.checkpoint.history, ...(this.evaluation ? [this.experiment()] : [])].find(e => e.experimentId === experimentId)
    assert(experiment?.execution.oofDigest, 'OOF outside visible evidence')
    const id = experiment.execution.oofDigest
    let bytes
    if (experiment.rolloutRunId === this.runId && this.evaluation.status !== 'reused') bytes = await readFile(join(this.output, 'objects', id.slice(7)))
    else bytes = await readFile(join(this.data, 'objects', id.slice(7)))
    assert(sha(bytes) === id, 'OOF evidence changed')
    const rows = Object.entries(decodeOof(bytes))
    return { digest: id, total: rows.length, predictions: rows.slice(offset, offset + 100).map(([id, prediction]) => ({ id, prediction })) }
  }
  async reuse(solutionDigest, hypothesis) {
    assert(this.action && !this.started, 'one experiment per rollout; inspect first')
    const prior = [...this.checkpoint.history].reverse().find(e => validCandidate(e) && e.sourceDigest === solutionDigest
      && e.validationPlanDigest === digest(this.plan) && e.trainingSeed === this.plan.seed)
    assert(prior, 'no compatible historical validation')
    this.started = true; this.action = { action: 'reuse', parentExperimentId: prior.experimentId }
    this.solution = this.checkpoint.solutions.find(s => s.digest === solutionDigest)
    this.claim = { hypothesis, intendedChange: 'Register compatible historical solution in the current experiment slot.' }
    this.evaluation = { status: 'reused', foldMetrics: prior.execution.foldMetrics,
      ...(this.request.task.protocol === 'analysis-task@2'
        ? { metric: prior.execution.metric, pooledScore: internalScore(prior), pooledUtility: internalQuality(prior) }
        : { pooledAccuracy: prior.execution.pooledAccuracy }) }
    this.reusedEvidenceRefs = [prior.digest]; this.oofDigest = prior.execution.oofDigest
    this.internalReceipt = { digest: prior.execution.receiptDigest }
    return this.experiment()
  }
  async sourceFiles() {
    const files = {}
    const visit = async relative => {
      for (const name of await readdir(join(this.work, 'workspace', relative))) {
        const path = relative ? `${relative}/${name}` : name, absolute = join(this.work, 'workspace', path), s = await lstat(absolute)
        sourcePath(path); assert(!s.isSymbolicLink() && s.nlink === 1 || s.isDirectory(), 'unsafe workspace file')
        if (s.isDirectory()) await visit(path)
        else { assert(s.isFile(), 'non-regular workspace file'); files[path] = absolute }
      }
    }
    await visit(''); assert(Object.keys(files).length <= 64, 'too many source files'); return files
  }
  async analyze(path, signal) {
    assert(!this.evaluation, 'analysis closed after formal experiment'); sourcePath(path)
    const result = await this.meteredWorker({ operation: 'script', entrypoint: path, files: await this.sourceFiles(),
      inputs: { 'train.csv': join(this.data, 'train.csv'), 'predict.csv': join(this.data, 'predict.csv') }, argv: [],
      prediction: this.request.task.prediction, publicFiles: this.request.task.publicFiles ?? [], publicDirectory: join(this.data, 'public'),
      outputDirectory: join(this.work, `analysis-${randomUUID()}`), cpuSeconds: 30, wallSeconds: 60 }, signal)
    return result
  }
  async evaluate({ entrypoint, hypothesis, intendedChange }, signal) {
    assert(this.action && !this.evaluation && !this.started, 'one formal experiment per rollout; inspect first')
    this.started = true; this.claim = { hypothesis, intendedChange }
    const files = await this.sourceFiles(); assert(files[entrypoint] && entrypoint.endsWith('.py'), 'missing solution entrypoint')
    const entries = []
    for (const [path, file] of Object.entries(files).sort()) { const bytes = await readFile(file); entries.push({ path, digest: await this.object(bytes), bytes: bytes.length }) }
    this.solution = seal({ protocol: 'analysis-solution@1', files: entries, entrypoint, parameters: {}, trainingSeed: this.plan.seed,
      runtimeDigest: this.request.runtimeDigest, authoredByRunId: this.runId })
    const result = await this.meteredWorker({ operation: 'evaluate', files, entrypoint, train: join(this.data, 'train.csv'),
      prediction: this.request.task.prediction, validationPlan: this.plan, trainingSeed: this.plan.seed,
      publicFiles: this.request.task.publicFiles ?? [], publicDirectory: join(this.data, 'public'), outputDirectory: join(this.work, 'cv-output'),
      wallSeconds: this.request.experimentWallSeconds, cpuSeconds: this.request.experimentCpuSeconds }, signal)
    this.evaluation = result
    await atomicJson(join(this.output, 'experiment-diagnostics.json'), result.logs)
    this.oofDigest = result.oofPath ? await this.object(await readFile(result.oofPath))
      : result.oof ? await this.object(Buffer.from(JSON.stringify(result.oof))) : null
    this.internalReceipt = seal({ protocol: 'analysis-cv-receipt@1', requestDigest: this.request.digest, sourceDigest: this.solution.digest,
      validationPlanDigest: digest(this.plan), status: result.status, foldMetrics: result.foldMetrics,
      ...this.scores(result), oofDigest: this.oofDigest })
    await atomicJson(join(this.output, 'cv-receipt.json'), this.internalReceipt)
    return { ...result, solutionDigest: this.solution.digest, oof: undefined }
  }
  experiment() {
    const failed = !this.evaluation
    return seal({ protocol: this.request.task.protocol === 'analysis-task@2' ? 'analysis-experiment@2' : 'analysis-experiment@1', experimentId: `${this.runId}/experiment`, sequenceId: this.request.sequenceId,
      rolloutRunId: this.runId, slotIndex: this.request.slotIndex, parentExperimentId: this.action?.parentExperimentId ?? null,
      operator: this.action?.action ?? 'draft', sourceDigest: this.solution?.digest ?? null,
      validationPlanDigest: digest(this.plan), trainingSeed: this.plan.seed,
      claim: this.claim ?? { hypothesis: '', intendedChange: '' },
      execution: { status: failed ? 'generation_failed' : this.evaluation.status,
        receiptDigest: this.internalReceipt?.digest ?? digest({ runId: this.runId, status: 'generation_failed' }),
        physicalAttemptRefs: [this.runId], reusedEvidenceRefs: this.reusedEvidenceRefs ?? [], cost: this.budget.snapshot().used,
        foldMetrics: this.evaluation?.foldMetrics ?? [], ...this.scores(this.evaluation), oofDigest: this.oofDigest ?? null },
      interpretation: this.interpretation ?? { conclusion: '', limitations: this.evaluation?.status === 'candidate_failed'
        ? [JSON.stringify(this.evaluation.logs).slice(-8000)] : [] } })
  }
  scores(value) {
    return this.request.task.protocol === 'analysis-task@2'
      ? { metric: this.request.task.prediction.metric, pooledScore: value?.pooledScore ?? null, pooledUtility: value?.pooledUtility ?? null }
      : { pooledAccuracy: value?.pooledAccuracy ?? null }
  }
  async select(signal) {
    assert(this.selection === undefined, 'selection already sealed')
    const decision = await this.policy('select', signal)
    assert(decision.action.action === 'select', 'policy_error: select required')
    const chosen = decision.action.solutionDigest
    const eligible = this.state('select').eligibleExperiments
    assert(chosen === null ? eligible.length === 0 : eligible.some(e => e.sourceDigest === chosen), 'policy_error: ineligible selection')
    this.selection = chosen; this.selectedAt = new Date().toISOString()
    return { selectedSolutionDigest: chosen, policyDigest: this.trace.at(-1).policyDigest }
  }
  async finish(conclusion, limitations) {
    assert(this.selection !== undefined && !this.finished, 'select before finish; finish once')
    this.interpretation = { conclusion, limitations }; this.finished = true
    await this.publish(); return { status: 'sealed', selectedSolutionDigest: this.selection }
  }
  async closeIncomplete(reason) {
    if (this.finished) return
    try { if (this.selection === undefined) await this.select(AbortSignal.timeout(20000)) }
    catch (error) { if (error.code === 'POLICY_ERROR') return this.failPolicy(error); throw error }
    this.interpretation = { conclusion: '', limitations: [reason] }
    this.finished = true; await this.publish()
  }
  async failPolicy(error) {
    assert(error.code === 'POLICY_ERROR' && !this.infrastructureFailure, 'only an attributable policy failure can be sealed')
    // This is a declared failure/carry-forward event, never another selection
    // algorithm or an additional experiment. Remaining slots are not started.
    this.evaluation = { status: 'candidate_failed', foldMetrics: [], pooledAccuracy: null, logs: [error.message] }
    this.oofDigest = null; this.reusedEvidenceRefs = []
    this.internalReceipt = seal({ protocol: 'analysis-policy-failure@1', runId: this.runId, reason: error.message })
    this.selection = this.checkpoint.currentSolutionDigest; this.selectedAt = new Date().toISOString()
    this.interpretation = { conclusion: 'policy_error: research stopped', limitations: [error.message] }
    this.stop = true; this.finished = true; await this.publish()
    return { status: 'policy_error', selectedSolutionDigest: this.selection, carryForward: true, stopped: true }
  }
  async publish() {
    assert(!this.infrastructureFailure, 'fixed worker evidence unavailable; no research receipt can be certified')
    const experiment = this.experiment()
    // Output manifest digest is added by the controller after Hitch seals artifacts.
    const receipt = seal({ protocol: 'analysis-rollout-output@1', requestDigest: this.request.digest, runId: this.runId,
      experiment, solutions: this.solution ? [this.solution] : [], selectedSolutionDigest: this.selection,
      availableEvidenceRefs: [...this.checkpoint.history.map(e => e.digest), experiment.digest],
      selectionPolicyDigest: digest(this.harness.manifest.artifacts.filter(f => f.path.startsWith('workflows/research/'))),
      sealedAt: this.selectedAt, cost: this.budget.snapshot().used, stop: this.stop ?? false })
    await atomicJson(join(this.output, 'receipt.json'), receipt)
    await atomicJson(join(this.output, 'policy-trace.json'), this.trace)
    await atomicJson(join(this.output, 'budget.json'), this.budget.snapshot())
  }
}
