import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileLockHeld } from '../../src/adapters/storage/file-lock.js'
import { registerOperation, withJournal } from '../../src/adapters/codex/journal.js'
import type { CodexInput } from '../../src/adapters/codex/contracts.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { ProcessOperationProvider } from '../../src/adapters/process/operation-provider.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { describeCodex } from '../../src/adapters/codex/identity.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { TrajectoryStore } from '../../src/adapters/storage/trajectory.js'
import type { TrajectoryReference } from '../../src/domain/trajectory.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { ExperienceStore } from '../../src/adapters/storage/experience.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../../src/adapters/python/builtin-policy.js'
import type { ExperienceRecord, ExperienceContext } from '../../src/domain/experience.js'
import type { OperatorMaterial } from '../../src/domain/operator-run.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import type { SearchView } from '../../src/domain/algorithm-wire.js'
import type * as V2 from '../../src/domain/algorithm-wire-v2.js'

const roots: string[] = [], operationRoots: string[] = []
const workerGroups = new Set<number>()
async function rememberWorker(directory: string) {
  try {
    const { pid } = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    workerGroups.add(pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  // A receipt precedes cleanup: keep operation and sandbox roots until their writer exits.
  for (const namespace of operationRoots.splice(0)) {
    const entries = await readdir(namespace, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    })
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      const directory = join(namespace, entry.name)
      await rememberWorker(directory)
      if ((await readdir(directory)).includes('execution.lock'))
        await expect.poll(() => fileLockHeld(join(directory, 'execution.lock')), { timeout: 8000 }).toBe(false)
    }
  }
  const groups = new Set(workerGroups); workerGroups.clear()
  if (groups.size)
    await expect.poll(async () => {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
      return stdout.split('\n').filter(line => {
        const [group, state] = line.trim().split(/\s+/u)
        return groups.has(Number(group)) && !state?.startsWith('Z')
      })
    }, { timeout: 8000 }).toEqual([])
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(mode = 'success', adapter: 'pi' | 'dsh' = 'pi', prepare = true, taskIds = ['seed']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-codex-test-')))
  roots.push(root)
  const privateRoot = join(root, 'private'),
    targets = join(privateRoot, 'targets'),
    directory = join(privateRoot, 'operations')
  await mkdir(join(targets, 'anchor'), { recursive: true })
  await mkdir(directory)
  operationRoots.push(directory)
  await writeFile(join(privateRoot, 'held-out.json'), 'HELD_OUT_PRIVATE_CANARY')
  const harness = adapter === 'pi' ? new PiHarnessAdapter() : new DshHarnessAdapter()
  await harness.prepare(join(targets, 'anchor'))
  const executable = join(root, 'fake-codex.mjs'), hitch = join(root, 'fake-hitch.mjs')
  await writeFile(executable, '#!/bin/sh\necho "codex-cli 0.145.0"\n', { mode: 0o700 })
  await writeFile(hitch, `#!${process.execPath}\nimport {metaHitchFixture} from ${JSON.stringify(new URL('../fixtures/meta-hitch.mjs', import.meta.url).href)};await metaHitchFixture(${JSON.stringify({mode, adapter})});`, { mode: 0o700 })
  const profile = {
    command: [process.execPath, resolve('assets/codex-meta-runner.mjs')],
    workingDirectory: root,
    configuration: { executable, hitch: { executable: hitch, root: join(root, 'hitch-state') }, model: 'fixture-model', reasoningEffort: 'max' as const, allowedDomains: ['chatgpt.com'], timeoutMs: 12_000,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) },
    passEnv: [],
    timeoutMs: 20_000,
  }
  const context = {
    runId: 'run',
    targetAdapter: adapter,
    targets,
    directory,
    experiencePython: resolvePythonExecutable(),
    protectedPaths: [privateRoot],
    tasks: taskIds.map(id => ({ id, instruction: 'Produce the requested answer.', family: 'format' })),
  }
  const provider = await ProcessOperationProvider.connect(profile, context as unknown as Json)
  if (prepare) await provider.prepareAdmission()
  const request: OperationRequest = {
    operationId: canonicalDigest({ mode, adapter }),
    runId: 'run',
    generation: 1,
    operation: {
      kind: 'generate_candidate',
      candidate_id: 'candidate',
      parent_id: 'anchor',
    task_ids: taskIds,
      scope: 'global',
      rationale: 'Improve format',
      payload: { hypothesis: 'Respect output format' },
    },
    partition: 'seed',
    repetitions: 0,
    slots: [],
    evidence: [
      {
        candidate_id: 'anchor',
        task_id: 'seed',
        repetition: 0,
        score: 0,
        status: 'valid',
        scope: 'global',
        feedback: 'wrong format',
      },
    ],
  }
  return {
    provider,
    request,
    root,
    privateRoot,
    directory: join(directory, request.operationId.slice(7)),
    targets,
    profile,
    context,
  }
}
const signal = () => new AbortController().signal
async function modelProcessIds(directory: string): Promise<number[]> {
  // Linux PID namespaces report a different PID inside the sandbox. Observe
  // the uniquely named fixture from the host, where cancellation is asserted.
  const executable = resolve(directory, '../../..', 'fake-hitch.mjs')
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=', '-o', 'args='])
  return stdout.split('\n').filter(line => line.includes(executable)).map(line => Number(line.trim().split(/\s+/u)[0]))
}
async function untilStarted(directory: string) {
  for (let index = 0; index < 120; index++) {
    try {
      if ((await readFile(join(directory, 'stderr.log'), 'utf8')).includes('test.started')) {
        // Some cases deliberately remove started.json after this point.
        await rememberWorker(directory)
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('fake Codex did not start')
}
describe('formal Codex operation runner', () => {
  it('executes generic operator Meta with multiple immutable donors and its Python output schema', async () => {
    const f = await fixture('operator')
    f.request.operation = { ...f.request.operation, kind: 'diagnose_seed', candidate_id: 'anchor', parent_id: null, payload: null }
    const donors = ['one', 'two'].map(name => ({ run_id: 'run', kind: 'library', digest: canonicalDigest(name), visibility: 'optimization' as const }))
    f.request.operatorCall = {
      version: 2, callId: canonicalDigest('operator-call'),
      effect: { kind: 'meta', input: {
        candidate: { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') },
        sources: donors, task_ids: ['seed'], data: null, max_tokens: null,
        prompt: 'Choose between the frozen donor materials',
        schema: { type: 'object', properties: { selected: { type: 'string' } }, required: ['selected'], additionalProperties: false },
      } },
      materials: donors.map((ref, index) => ({ ref, files: { 'prompt.md': {
        content: Buffer.from('donor ' + ['one', 'two'][index]).toString('base64'), encoding: 'base64' as const, executable: false,
      } } })),
    }
    const result = await f.provider.submit(f.request, signal())
    expect(result.result.status).toBe('complete')
    expect(result.result.data).toMatchObject({ data: { selected: 'donor two' } })
    expect(result.usage).toMatchObject({ model_requests: 1, tokens: 19 })
    expect((await f.provider.inspect(f.request, signal())).state).toBe('complete')
  }, 30_000)
  it('hands baseline and older rejected source plus successful and failed trajectories to Meta across rounds', async () => {
    const f = await fixture('operator-history')
    f.request.operation = {
      ...f.request.operation,
      kind: 'diagnose_seed',
      candidate_id: 'anchor',
      parent_id: null,
      payload: null,
    }
    const anchor = { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') }
    const older = { run_id: 'run', candidate_id: 'older-rejected', digest: canonicalDigest('older') }
    const trace = (name: string) => ({
      run_id: 'run',
      kind: 'target_trajectory',
      digest: canonicalDigest(name),
      visibility: 'agent' as const,
    })
    const schema = {
      type: 'object',
      properties: { base_candidate_id: { type: 'string', enum: ['anchor', 'older-rejected'] } },
      required: ['base_candidate_id'],
      additionalProperties: false,
    }
    const source = (ref: typeof anchor | ReturnType<typeof trace>, label: string, code = '') => ({
      ref,
      files: {
        'source.json': {
          content: Buffer.from(JSON.stringify({ label, kind: 'candidate_id' in ref ? 'candidate' : ref.kind })).toString('base64'),
          encoding: 'base64' as const,
          executable: false,
        },
        ...(code ? { 'large-source.py': {
          content: Buffer.from(code).toString('base64'),
          encoding: 'base64' as const,
          executable: false,
        } } : {}),
      },
    })
    const submitDiagnosis = async (round: number, sources: ReturnType<typeof source>[]) => {
      f.request.operationId = canonicalDigest(['history-worker', round])
      f.request.operatorCall = {
        version: 2,
        callId: canonicalDigest(['history-call', round]),
        effect: { kind: 'meta', input: {
          candidate: anchor,
          sources: sources.map(item => item.ref),
          task_ids: ['seed'],
          data: { round },
          max_tokens: null,
          prompt: 'Inspect every provided evaluated candidate and its captured seed trajectories.',
          schema,
        } },
        materials: sources,
      }
      return f.provider.submit(f.request, signal())
    }
    const baselineSources = [
      source(anchor, 'baseline source'),
      source(trace('baseline-success'), 'successful baseline trajectory'),
      source(trace('baseline-failure'), 'failed baseline trajectory'),
    ]
    const baseline = await submitDiagnosis(0, baselineSources)
    expect(baseline.result.status).toBe('complete')
    expect(baseline.result.data).toMatchObject({ data: { base_candidate_id: 'anchor' } })

    const largeHistoricalSource = '# Historical implementation\n' + 'x'.repeat(350_000)
    const historicalSources = [
      ...baselineSources,
      source(older, 'older rejected candidate', largeHistoricalSource),
      source(trace('older-success'), 'successful older trajectory'),
      source(trace('older-failure'), 'failed older trajectory'),
    ]
    const next = await submitDiagnosis(1, historicalSources)
    expect(next.result.status).toBe('complete')
    expect(next.result.data).toMatchObject({ data: { base_candidate_id: 'older-rejected' } })
  }, 30_000)
  it('connects MetaHarness frozen-worker decisions to the actual Meta worker across rounds', async () => {
    const taskIds = ['seed-pass', 'seed-fail']
    const f = await fixture('operator-history-algorithm', 'pi', true, taskIds)
    const sourceRoot = join(f.root, 'algorithm-source'), scratch = join(f.root, 'algorithm-scratch')
    await mkdir(scratch)
    const identity = await freezeAlgorithmSource(sourceRoot)
    const worker = new PythonAlgorithmWorker({
      python: resolvePythonExecutable(), sourceRoot, scratch, implementationIdentity: identity,
      protocolVersion: 2,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}),
    })
    const anchor = { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') }
    const older = { run_id: 'run', candidate_id: 'older-rejected', digest: canonicalDigest('older') }
    const traceNames = new Map([
      [canonicalDigest('baseline-success'), 'successful baseline trajectory'],
      [canonicalDigest('baseline-failure'), 'failed baseline trajectory'],
      [canonicalDigest('older-success'), 'successful older trajectory'],
      [canonicalDigest('older-failure'), 'failed older trajectory'],
    ])
    const trace = (name: string): V2.ArtifactRef => ({
      run_id: 'run', kind: 'target_trajectory', digest: canonicalDigest(name), visibility: 'optimization',
    })
    const largeHistoricalSource = '# Historical implementation\n' + 'x'.repeat(350_000)
    const material = (ref: V2.SourceRef): OperatorMaterial => {
      const isCandidate = 'candidate_id' in ref
      const label = isCandidate
        ? ref.candidate_id === 'anchor' ? 'baseline source' : 'older rejected candidate'
        : traceNames.get(ref.digest)
      if (!label) throw new Error(`No fixture material for ${JSON.stringify(ref)}`)
      const manifest = { label, kind: isCandidate ? 'candidate' : ref.kind }
      return {
        ref,
        files: {
          'source.json': {
            content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
            encoding: 'base64', executable: false,
          },
          ...(label === 'older rejected candidate' ? {
            'large-source.py': {
              content: Buffer.from(largeHistoricalSource).toString('base64'),
              encoding: 'base64' as const, executable: false,
            },
          } : {}),
        },
      }
    }
    const tasks: V2.Task[] = taskIds.map(id => ({ id, family: 'format', estimated_cost: 1, input: null }))
    const view: V2.SearchView = {
      run_id: 'run', step_id: 0, seed: 'meta-harness-history-fixture', tasks,
      candidates: [anchor], results: [],
      budget: { rounds: 2, repetitions: 1, candidates_remaining: 4, generation_requests_remaining: 8 },
      anchor, objective: null, history: null, stream: null, assets: [], capabilities: [],
    }
    const algorithm = { name: 'gear.algorithms.meta_harness:MetaHarness', options: {}, protocol_version: 2 as const }
    const state: V2.AlgorithmState = { version: 1, data: {} }
    const completed = (decision: V2.Decision, value: V2.Json, artifacts: V2.ArtifactRef[] = []) => {
      view.results.push({
        ref: decision.state.data.pending as V2.CallRef,
        status: 'succeeded', value, error: null, artifacts, usage: null,
      })
      view.step_id += 1
    }
    const evidenceSet = (candidate: V2.CandidateRef, scores: number[], traces: V2.ArtifactRef[]) => {
      const assessments = taskIds.map(taskId => ({
        run_id: 'run', kind: 'assessment', digest: canonicalDigest([candidate.candidate_id, taskId]),
        visibility: 'optimization' as const,
      }))
      const tasks = taskIds.map(taskId => ({ task_id: taskId, slots: [0] }))
      const spec = {
        candidate, assessments, tasks,
        task_weights: taskIds.map(taskId => [taskId, 1 / taskIds.length]),
        objective_ref: canonicalDigest(null), reducer_ref: 'mean-v1', missing_policy: 'incomplete' as const,
      }
      return {
        ref: { run_id: 'run', kind: 'evidence_set', digest: canonicalDigest([candidate, scores]), visibility: 'optimization' as const },
        spec,
        records: taskIds.map((taskId, index) => ({
          sample_id: `${candidate.candidate_id}/${taskId}`, attempt_id: `${candidate.candidate_id}-attempt`,
          assessment: assessments[index]!, task_id: taskId, slot: 0, score: scores[index]!,
          status: scores[index] === 1 ? 'valid' as const : 'task_failed' as const, raw_metrics: null,
        })),
        loaded: true, cursor: null,
        executions: taskIds.map((taskId, index) => ({
          sample_id: `${candidate.candidate_id}/${taskId}`, attempt_id: `${candidate.candidate_id}-attempt`,
          task_id: taskId, status: scores[index] === 1 ? 'valid' : 'task_failed', output: null,
          trajectory: traces[index] ?? null,
        })),
      }
    }
    const submitMeta = async (decision: V2.Decision, round: number) => {
      const call = decision.calls[0]!
      if (call.effect.kind !== 'meta') throw new Error('MetaHarness did not request Meta')
      f.request.operationId = canonicalDigest(['algorithm-meta', round])
      f.request.operation = {
        kind: 'diagnose_seed', candidate_id: 'anchor', parent_id: null, task_ids: taskIds,
        scope: 'global', rationale: 'History-driven Meta-Harness diagnosis', payload: null,
      }
      f.request.operatorCall = {
        version: 2, callId: canonicalDigest(['algorithm-meta-call', round]), effect: call.effect,
        materials: call.effect.input.sources.map(material),
      }
      return f.provider.submit(f.request, signal())
    }
    try {
      await worker.start(signal())
      const baseline = await worker.stepV2(view, state, algorithm, signal())
      expect(baseline.calls[0]?.effect.kind).toBe('execute')
      const baselineResult = evidenceSet(anchor, [1, 0], [trace('baseline-success'), trace('baseline-failure')])
      completed(baseline, baselineResult, [baselineResult.ref])
      const firstMeta = await worker.stepV2(view, baseline.state, algorithm, signal())
      const firstReceipt = await submitMeta(firstMeta, 0)
      expect(firstReceipt.result.status).toBe('complete')
      expect(firstReceipt.result.data).toMatchObject({ data: { base_candidate_id: 'anchor' } })
      completed(firstMeta, firstReceipt.result.data)

      const generation = await worker.stepV2(view, firstMeta.state, algorithm, signal())
      expect(generation.calls[0]?.effect.kind).toBe('candidate')
      completed(generation, { candidate: older })
      view.candidates.push(older)
      const evaluation = await worker.stepV2(view, generation.state, algorithm, signal())
      expect(evaluation.calls[0]?.effect.kind).toBe('execute')
      const olderResult = evidenceSet(older, [0, 0], [trace('older-success'), trace('older-failure')])
      completed(evaluation, olderResult, [olderResult.ref])
      const secondMeta = await worker.stepV2(view, evaluation.state, algorithm, signal())
      const secondReceipt = await submitMeta(secondMeta, 1)
      expect(secondReceipt.result.status).toBe('complete')
      expect(secondReceipt.result.data).toMatchObject({ data: { base_candidate_id: 'older-rejected' } })
      completed(secondMeta, secondReceipt.result.data)

      const selectedParent = await worker.stepV2(view, secondMeta.state, algorithm, signal())
      expect(selectedParent.calls[0]?.effect).toMatchObject({ kind: 'candidate', input: { base: older } })
    } finally { await worker.dispose() }
  }, 60_000)
  it.each([
    ['base_candidate_id', false], ['another_algorithm_field', false], ['base_candidate_id', true],
  ] as const)('Python alone defines and validates Meta field %s (invalid=%s)', async (resultKey, invalid) => {
    const f = await fixture(invalid ? 'historical-invalid' : 'historical')
    await new PiHarnessAdapter().prepare(join(f.targets, 'older'))
    const source = join(f.root, 'source'), scratch = join(f.root, 'scratch')
    await mkdir(scratch)
    const identity = await freezeAlgorithmSource(source, [{ path: 'pr_cases.py', source: resolve('tests/fixtures/python-algorithm-boundaries.py') }])
    const worker = new PythonAlgorithmWorker({ python: resolvePythonExecutable(), sourceRoot: source, scratch, implementationIdentity: identity,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
    const view: SearchView = { run_id: 'run', step_id: 0, seed: 'fixed', anchor_id: 'anchor',
      candidates: ['anchor', 'older'].map(id => ({ id, digest: canonicalDigest(id), parent_id: null })),
      tasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }],
      evidence: ['anchor', 'older'].map(candidate_id => ({ candidate_id, task_id: 'seed', repetition: 0, score: 1, status: 'valid', scope: 'global', feedback: 'passed' })),
      completed: [], budget: { rounds: 1, repetitions: 1, candidates_remaining: 1, evaluations_remaining: 2 } }
    const algorithm = { name: 'pr_cases:HistoricalBase', options: { result_key: resultKey } }
    try {
      await worker.start(signal())
      const diagnosis = await worker.step(view, { version: 1, data: {} }, algorithm, signal())
      const receipt = await f.provider.submit({ ...f.request, operation: diagnosis.operations[0]!, evidence: view.evidence }, signal())
      expect(receipt.result.status).toBe('complete')
      view.completed.push(receipt.result); view.step_id++
      if (invalid) {
        // The model's schema is guidance, not the algorithm's semantic validation.
        const rejected = await worker.step(view, diagnosis.state, algorithm, signal())
        expect(rejected.state.data.rejected).toBe('historical base not offered')
        expect(rejected.operations.map(operation => operation.kind)).toEqual(['stop'])
        expect(receipt.candidate).toBeNull()
        return
      }
      const generation = await worker.step(view, diagnosis.state, algorithm, signal())
      expect(generation.operations[0]).toMatchObject({ kind: 'generate_candidate', parent_id: 'older' })
      const generated = await f.provider.submit({ ...f.request, operationId: canonicalDigest('historical-generation'), operation: generation.operations[0]! }, signal())
      expect(generated.result.status).toBe('complete')
      expect(generated.candidate).toMatchObject({ id: 'new', parent_id: 'older' })
      expect(generated.result.data).toEqual({ declined: false, data: 'Updated the selected candidate.' })
    } finally { await worker.dispose() }
  }, 30_000)

  it('public Python SDK freezes one external algorithm file, its configuration and recovery', async () => {
    const f = await fixture('historical-sdk')
    const profiles = join(f.root, 'profiles'), project = join(f.root, 'sdk-project')
    await mkdir(profiles)
    vi.stubEnv('GEAR_PROFILE_ROOT', profiles)
    const python = resolvePythonExecutable()
    // Persist the evaluation receipt, then lose its reply to require a fresh SDK resume.
    const targetProvider = join(f.root, 'target-provider.mjs')
    await writeFile(targetProvider, (await readFile(resolve('tests/fixtures/project-provider.mjs'), 'utf8')).replaceAll(
      'process.stdout.write(JSON.stringify(result))',
      "if (action === 'submit' && request.operation.kind === 'evaluate_seed' && request.operation.candidate_id !== 'anchor') throw new Error('lost SDK evaluation reply'); process.stdout.write(JSON.stringify(result))"))
    await writeFile(join(profiles, 'sdk-target.json'), JSON.stringify({ command: [process.execPath, targetProvider],
      workingDirectory: f.root, passEnv: ['PYTHONPATH'], timeoutMs: 30_000,
      configuration: { python, receipts: join(f.root, 'target-receipts') } }))
    await writeFile(join(profiles, 'sdk-meta.json'), JSON.stringify(f.profile))
    await initProject(project, { adapter: 'pi', template: 'text', targetProfile: 'sdk-target', metaProfile: 'sdk-meta' })
    await writeFile(join(project, 'tasks.csv'), 'id,instruction,expected,family,split\nseed,Produce the requested answer.,42,format,seed\nheld-out,Private task.,43,private-family,held_out\n')
    if (process.env.GEAR_TEST_LINUX_ISOLATION)
      await writeFile(join(project, 'gear.yaml'), await readFile(join(project, 'gear.yaml'), 'utf8') + `\nsandbox: {linux_isolation: ${process.env.GEAR_TEST_LINUX_ISOLATION}}\n`)
    const ownFile = join(project, 'own_algorithm.py')
    await writeFile(ownFile, await readFile(resolve('tests/fixtures/python-algorithm-boundaries.py')))
    const sdk = (code: string) => promisify(execFile)(python, ['-c', code], { cwd: project, timeout: 60_000,
      env: { ...process.env, PYTHONPATH: resolve('python'), GEAR_PYTHON: python,
        GEAR_COMMAND: JSON.stringify([process.execPath, resolve('lib/cli.js')]) } })
    const failed = await sdk("from gear import Project; from own_algorithm import SDKExample; Project.open().refine(algorithm=SDKExample(result_key='sdk_selected'), rounds=1)").then(() => null, error => error)
    const runs = join(project, '.gear/runs'), [id] = await readdir(runs)
    expect(id).toBeTruthy()
    const runRoot = join(runs, id!), journalPath = join(runRoot, 'journal.json')
    const before = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(failed?.stderr ?? '', JSON.stringify({ status: before.status, operations: before.operations.map((entry: {status: string}) => entry.status) })).toMatch(/lost SDK evaluation reply|process-operation-failed/)
    expect(before.status).toBe('needs_recovery')
    expect(before.spec.algorithm).toEqual({ name: 'own_algorithm:SDKExample', options: { result_key: 'sdk_selected' } })
    expect(before.operations.map((entry: { request: OperationRequest }) => entry.request.operation.kind)).toEqual(['evaluate_seed', 'diagnose_seed', 'generate_candidate', 'evaluate_seed'])
    expect(before.operations[1].receipt.result.data.data).toEqual({ sdk_selected: 'anchor' })
    expect(before.operations[2].receipt.result.candidate_change.omitted_patches).toBe(0)
    expect(before.operations[3].status).toBe('submitted')
    expect(await readFile(join(runRoot, 'algorithm/own_algorithm.py'), 'utf8')).toBe(await readFile(ownFile, 'utf8'))
    await writeFile(ownFile, "raise RuntimeError('mutable author file must not be reloaded')\n")
    await sdk(`from gear import Project; Project.open().resume(${JSON.stringify(id)})`)
    const after = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(after.status).toBe('completed')
    expect(after.operations).toHaveLength(4)
    expect(after.operations[1].receipt).toEqual(before.operations[1].receipt)
    expect(after.operations[2].receipt).toEqual(before.operations[2].receipt)
    expect(after.decisions.at(-1).decision.operations[0].kind).toBe('stop')
  }, 90_000)

  it('binds the optional code-mode companion to the runtime identity', async () => {
    const { profile, root } = await fixture()
    const before = await describeCodex(profile.configuration)
    const companion = join(root, 'codex-code-mode-host')
    await writeFile(companion, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const present = await describeCodex(profile.configuration)
    expect(present.codeModeHost).toBe(companion)
    expect(present.identity).not.toBe(before.identity)
    await writeFile(companion, '#!/bin/sh\nexit 1\n')
    expect((await describeCodex(profile.configuration)).identity).not.toBe(present.identity)
  })
  for (const withTrajectory of [false, true])
  it(`queries and reads frozen seed experiences${withTrajectory ? ' and trajectory pages' : ''} through the authorized Hitch handoff`, async () => {
    const { provider: initialProvider, request, context, root, profile } = await fixture('success', 'pi', false)
    let provider = initialProvider
    const trajectory_refs: TrajectoryReference[] = []
    if (withTrajectory) {
      const hitchRoot = join(root, 'hitch-private'), run = 'run_' + 'a'.repeat(32), executable = join(root, 'hitch.mjs')
      await mkdir(hitchRoot)
      await writeFile(join(hitchRoot, 'private.txt'), 'PROVIDER_PRIVATE_CANARY')
      await writeFile(join(hitchRoot, run + '.json'), JSON.stringify([{ seq: 0, type: 'assistant/message', data: 'historical seed trace' }, { seq: 1, type: 'tool/result', data: 'result' }]))
      await writeFile(executable, `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`, { mode: 0o700 })
      // The detached operation runs the installed JS adapter. Bind that actual implementation.
      const { HitchArtifactReader } = await import(new URL('../../lib/adapters/hitch/trajectory.js', import.meta.url).href)
      const reader = new HitchArtifactReader(executable, hitchRoot)
      const artifact = await reader.capture(run, 'seed', 0, signal())
      expect(artifact.status).toBe('available')
      const source = await new TrajectoryStore(join(context.targets, '../trajectory-sources')).save({ version: 1, run_id: 'run', candidate_id: 'anchor', operation_id: canonicalDigest('evaluation'), origin_run_id: 'run', origin_candidate_id: 'anchor', receipt_digest: canonicalDigest('receipt'), reader_identity: canonicalDigest(reader.descriptor), partition: 'seed', artifact })
      trajectory_refs.push({ ref: 'trajectory:' + source.digest.slice(7), candidate_id: 'anchor', task_id: 'seed', repetition: 0, status: artifact.status, content_digest: artifact.content_digest, reason: null })
      provider = await ProcessOperationProvider.connect(profile, { ...context, artifactReader: reader.descriptor, experiencePython: resolvePythonExecutable() } as unknown as Json)
    }
    await provider.prepareAdmission()
    const record = builtinPolicy<ExperienceRecord>('experience_record', {
      source: { run_id: 'run' }, candidate: { id: 'anchor', digest: canonicalDigest('anchor'), parent_id: 'older' },
      parent: { id: 'older', digest: canonicalDigest('older'), parent_id: null }, task_ids: ['seed'], repetitions: 1,
      objective: null, evidence: ['older', 'anchor'].map((candidate_id, index) => ({ candidate_id, task_id: 'seed', repetition: 0, status: 'valid', score: index === 0 ? 1 : 0 })),
      trajectory_refs,
      proposal: { rationale: 'format', hypothesis: 'format', semantic_targets: [] },
      change: { files: [{ path: 'AGENTS.md', patch: '-before\n+after\n' }] },
    })
    const body = { version: 2 as const, run_id: 'run', source_archive_digest: canonicalDigest('archive'), implementation_identity: builtinPolicyImplementationDigest, records: [record] }
    const snapshot = { ...body, digest: canonicalDigest(body) }
    await new ExperienceStore(join(context.targets, '../experience')).save(snapshot)
    const selected = builtinPolicy<Omit<ExperienceContext, 'digest' | 'implementation_identity'>>('experience_context', { records: [record], snapshot_digest: snapshot.digest, parent_id: 'anchor', evidence: request.evidence })
    const memory = { ...selected, implementation_identity: snapshot.implementation_identity }
    request.experience = { ...memory, digest: canonicalDigest(memory) }
    request.operationId = canonicalDigest([request.operationId, request.experience.digest])
    const receipt = await provider.submit(request, signal())
    const diagnostic = await readFile(join(context.directory, request.operationId.slice(7), 'stderr.log'), 'utf8').catch(() => '')
    expect(receipt.result.status, JSON.stringify(receipt) + diagnostic).toBe('complete')
    expect(receipt.result.data).toMatchObject({ summary: 'read isolation verified' })
  }, 30_000)
  it('does not report completed-turn usage as the total after a later turn fails', async () => {
    const { provider, request } = await fixture('partialfailed')
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.status).toBe('failed')
    expect(receipt.candidate).toBeNull()
    expect(receipt.usage).toMatchObject({ tokens: null, model_requests: 2 })
  }, 30_000)
  for (const adapter of ['pi', 'dsh'] as const)
    it(`isolates seed/candidate and persists one ${adapter} generation`, async () => {
      const { provider, request, targets, directory } = await fixture('success', adapter)
      const [first, duplicate] = await Promise.all([
        provider.submit(request, signal()),
        provider.submit(request, signal()),
      ])
      expect(
        first.result.status,
        await readFile(join(directory, 'stderr.log'), 'utf8').catch(() => 'no native diagnostics'),
      ).toBe('complete')
      expect(first.result.data).toMatchObject({ summary: 'read isolation verified' })
      expect(duplicate).toEqual(first)
      expect(first.candidate).toMatchObject({ id: 'candidate', parent_id: 'anchor' })
      expect(first.usage).toEqual({
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
        tokens: 19,
        model_requests: 1,
      })
      expect((await readFile(join(directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(
        1,
      )
      expect(await provider.inspect(request, signal())).toEqual({ state: 'complete', receipt: first })
      expect(
        await readFile(join(targets, 'anchor', adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'), 'utf8'),
      ).toContain('Follow the task instruction')
      await expect(provider.submit({ ...request, generation: 2 }, signal())).rejects.toThrow(
        'codex-operation-conflict',
      )
    }, 30_000)
  it('recovers a durable receipt after the waiting caller is interrupted', async () => {
    const { provider, request, directory } = await fixture('slow')
    const controller = new AbortController()
    const waiting = provider.submit(request, controller.signal).catch((error) => error)
    await untilStarted(directory)
    controller.abort()
    expect(await waiting).toBeInstanceOf(Error)
    expect((await provider.inspect(request, signal())).state).toBe('running')
    await delay(2700)
    const result = await provider.inspect(request, signal())
    expect(result.state).toBe('complete')
    if (result.state === 'complete') expect(result.receipt.result.status).toBe('complete')
    expect((await readFile(join(directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
  }, 30_000)
  it('cancels the owned process and persists its failed receipt', async () => {
    const { provider, request, directory } = await fixture('hold')
    const waiting = provider.submit(request, signal())
    await untilStarted(directory)
    await provider.cancel(request)
    expect((await provider.inspect(request, signal())).state).toBe('complete')
    await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
    const receipt = await waiting
    expect(receipt.result.status).toBe('failed')
    expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
    expect(receipt.candidate).toBeNull()
    expect(await provider.submit(request, signal())).toEqual(receipt)
  }, 30_000)
  for (const mode of ['invalid', 'invalid-result', 'declined', 'protected'])
    it(`rejects ${mode} model output without publishing a candidate`, async () => {
      const { provider, request, targets } = await fixture(mode)
      const receipt = await provider.submit(request, signal())
      expect(receipt.result.status).toBe('failed')
      expect(receipt.candidate).toBeNull()
      if (mode.startsWith('invalid')) expect(receipt.result.data).toEqual({ error: 'codex-output-invalid' })
      if (mode === 'declined') expect(receipt.result.data).toMatchObject({ declined: true })
      await expect(readFile(join(targets, 'candidate/AGENTS.md'))).rejects.toThrow()
    }, 30_000)
  it('rejects held-out requests before model submission', async () => {
    const { provider, request } = await fixture()
    await expect(provider.submit({ ...request, partition: 'held_out' }, signal())).rejects.toThrow(
      'codex-request-invalid',
    )
    await expect(
      provider.submit({ ...request, evidence: [{ ...request.evidence[0]!, task_id: 'held-out' }] }, signal()),
    ).rejects.toThrow('codex-evidence-invalid')
    expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  })
  it('diagnoses using a read-only candidate and returns no candidate publication', async () => {
    const { provider, request } = await fixture()
    request.operation = {
      ...request.operation,
      kind: 'diagnose_seed',
      candidate_id: 'anchor',
      parent_id: null,
    }
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.status).toBe('complete')
    expect(receipt.candidate).toBeNull()
    expect(receipt.result.data).toMatchObject({ hypotheses: ['Respect output format'] })
  })
  it('fences cancellation before submission without starting a model', async () => {
    const { provider, request, directory } = await fixture()
    await provider.cancel(request)
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
    await expect(readFile(join(directory, 'events.jsonl'))).rejects.toThrow()
  })
  it('rejects a changed executable after handshake', async () => {
    const { provider, request, profile } = await fixture()
    await writeFile(
      profile.configuration.executable,
      (await readFile(profile.configuration.executable, 'utf8')) + '\n# changed implementation\n',
    )
    await expect(provider.submit(request, signal())).rejects.toThrow('codex-identity-changed')
    expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  })
  it('leaves a killed worker unknown, terminates its model child and never resubmits', async () => {
    const { provider, request, directory } = await fixture('hold')
    const waiting = provider.submit(request, signal()).catch((error) => error)
    await untilStarted(directory)
    const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
    const event = JSON.parse((await readFile(join(directory, 'stderr.log'), 'utf8')).split('\n')[0]!) as {
      pid: number
      cwd: string
    }
    process.kill(started.pid, 'SIGKILL')
    expect(await waiting).toBeInstanceOf(Error)
    expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
    await expect(provider.cancel(request)).rejects.toThrow('codex-cancellation-unconfirmed')
    await expect(provider.submit(request, signal())).rejects.toThrow('codex-result-unknown')
    await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
    expect(
      await readFile(join(event.cwd, 'AGENTS.md')).then(
        () => true,
        () => false,
      ),
      await readFile(join(directory, 'stderr.log'), 'utf8'),
    ).toBe(true)
    expect((await readFile(join(directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
  }, 30_000)
})

it('stops an owned Codex process through the admission snapshot after the model executable disappears', async () => {
  const { provider, request, directory, profile } = await fixture('hold')
  const waiting = provider.submit(request, signal())
  await untilStarted(directory)
  await rm(profile.configuration.executable)
  const cancel = await configuredCancellation(provider.cancellation)
  await cancel.cancel(request)
  const receipt = await waiting
  expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
  expect((await provider.inspect(request, signal())).state).toBe('complete')
}, 30_000)

for (const lost of ['job', 'operation', 'namespace', 'journal'] as const)
it(`does not confirm cancellation or replay when the ${lost} state disappears`, async () => {
  const { provider, request, directory, context } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  const path = lost === 'job' ? join(directory, 'job.json') : lost === 'operation' ? directory : lost === 'journal' ? join(context.directory, 'operations.json') : context.directory
  const backup = `${context.directory}-lost-${lost}`
  process.kill(worker.pid, 'SIGSTOP')
  await rename(path, backup)
  try {
    const cancel = await configuredCancellation(provider.cancellation)
    await expect(cancel.cancel(request)).rejects.toThrow()
    expect(await modelProcessIds(directory)).not.toEqual([])
    expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
    await expect(provider.submit(request, signal())).rejects.toThrow()
  } finally {
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    process.kill(worker.pid, 'SIGCONT')
    await provider.cancel(request)
    await waiting
  }
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
}, 30_000)

it('keeps describe read-only and never initializes missing operation state on reconnect', async () => {
  const { provider, request, context, profile } = await fixture('success', 'pi', false)
  const journal = join(context.directory, 'operations.json')
  await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
  await expect(provider.cancel(request)).rejects.toThrow('codex-state-unavailable')
  await provider.prepareAdmission()
  expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  await rm(journal)
  const restored = await ProcessOperationProvider.connect(profile, context as unknown as Json)
  expect(await restored.inspect(request, signal())).toEqual({ state: 'unknown' })
  await expect(restored.submit(request, signal())).rejects.toThrow('codex-state-unavailable')
  await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('requires a stopped receipt even if started.json disappears, then confirms actual termination', async () => {
  const { provider, request, directory } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  process.kill(worker.pid, 'SIGSTOP')
  try {
    await rm(join(directory, 'started.json'))
    await expect(provider.cancel(request)).rejects.toThrow('codex-cancellation-unconfirmed')
    expect(await modelProcessIds(directory)).not.toEqual([])
  } finally {
    process.kill(worker.pid, 'SIGCONT')
    await provider.cancel(request)
    await waiting
  }
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
  expect((await provider.inspect(request, signal())).state).toBe('complete')
}, 30_000)
it('does not restart a killed worker even if its started marker is also lost', async () => {
  const { provider, request, directory } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  process.kill(worker.pid, 'SIGKILL')
  expect(await waiting).toBeInstanceOf(Error)
  await rm(join(directory, 'started.json'))
  await promisify(execFile)(process.execPath, [resolve('assets/codex-meta-runner.mjs'), '--worker', directory])
  expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
  expect((await readFile(join(directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)


it('keeps a signal-killed Hitch without a stopped receipt unknown and never repeats its call', async () => {
  const f = await fixture('hold')
  const waiting = f.provider.submit(f.request, signal()).catch(error => error)
  await untilStarted(f.directory)
  const { pid: worker } = JSON.parse(await readFile(join(f.directory, 'started.json'), 'utf8')) as { pid: number }
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='])
  const rows = stdout.split('\n').map(line => line.trim().split(/\s+/u))
  const hitch = rows.find(row => Number(row[1]) === worker && row.slice(2).join(' ').includes('/fake-hitch.mjs'))
  expect(hitch).toBeDefined()
  const event = JSON.parse((await readFile(join(f.directory, 'stderr.log'), 'utf8')).split('\n')[0]!) as { cwd: string }
  roots.push(resolve(event.cwd, '..'))
  process.kill(Number(hitch![0]), 'SIGKILL')
  expect(await waiting).toBeInstanceOf(Error)
  expect(await f.provider.inspect(f.request, signal())).toEqual({ state: 'unknown' })
  await expect(readFile(join(f.directory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(join(f.directory, 'cleanup.json'), 'utf8'))).toMatchObject({ model_stopped: false, stages: { root: 'unconfirmed', credentials: 'unconfirmed' } })
  expect(await readFile(join(event.cwd, 'AGENTS.md'), 'utf8')).toContain('Follow the task instruction')
  await expect(f.provider.submit(f.request, signal())).rejects.toThrow('codex-result-unknown')
  expect((await readFile(join(f.directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)

it('refuses a real nonleader worker before writing started or spawning a model', async () => {
  const f = await fixture()
  const input: CodexInput = { version: 1, action: 'submit', configuration: f.profile.configuration, context: f.context, request: f.request, implementationIdentity: f.provider.implementationIdentity }
  const digest = canonicalDigest({ request: f.request, configuration: input.configuration, context: input.context, implementationIdentity: input.implementationIdentity })
  await withJournal(input, journal => registerOperation(input, journal, { digest, state: 'admitted' }))
  await mkdir(f.directory)
  await writeFile(join(f.directory, 'job.json'), JSON.stringify({ version: 1, input, digest, identity: input.implementationIdentity }))
  await expect(promisify(execFile)(process.execPath, [resolve('assets/codex-meta-runner.mjs'), '--worker', f.directory])).rejects.toMatchObject({ stderr: expect.stringContaining('codex-worker-group-invalid') })
  await expect(readFile(join(f.directory, 'started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.directory, 'events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fileLockHeld(join(f.directory, 'execution.lock'))).toBe(false)
  expect((await modelProcessIds(f.directory))).toEqual([])
})


it('cleans up and releases its lock after receipt publication fails without replaying the model', async () => {
  const f = await fixture('slow')
  const waiting = f.provider.submit(f.request, signal()).catch(error => error)
  await untilStarted(f.directory)
  // A private test-only directory conflicts with atomic receipt publication.
  // Create it after start so it cannot bypass the worker's execution admission.
  await mkdir(join(f.directory, 'receipt.json'))
  expect(await waiting).toBeInstanceOf(Error)
  await expect.poll(() => readFile(join(f.directory, 'cleanup.json'), 'utf8').then(JSON.parse).catch(() => null), { timeout: 8000 }).toMatchObject({ model_stopped: true, stages: { credentials: 'complete', gateway: 'complete', root: 'complete' } })
  await expect.poll(() => fileLockHeld(join(f.directory, 'execution.lock')), { timeout: 3000 }).toBe(false)
  const { pid } = JSON.parse(await readFile(join(f.directory, 'started.json'), 'utf8')) as { pid: number }
  await expect.poll(async () => {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
    return stdout.split('\n').some(line => { const [group, state] = line.trim().split(/\s+/u); return Number(group) === pid && !state?.startsWith('Z') })
  }, { timeout: 3000 }).toBe(false)
  const event = JSON.parse((await readFile(join(f.directory, 'stderr.log'), 'utf8')).split('\n')[0]!) as { cwd: string }
  await expect(readFile(join(event.cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Remove only the artificial conflict. Original admission/started state stays
  // intact and still forbids a second model execution without a durable result.
  await rm(join(f.directory, 'receipt.json'), { recursive: true })
  expect(await f.provider.inspect(f.request, signal())).toEqual({ state: 'unknown' })
  await expect(f.provider.submit(f.request, signal())).rejects.toThrow('codex-result-unknown')
  expect((await readFile(join(f.directory, 'stderr.log'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)
