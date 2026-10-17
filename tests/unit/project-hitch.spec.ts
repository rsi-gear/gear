import { fixtureRuntime } from '../helpers/hitch-runtime-fixture.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import * as hitchTransport from '../../src/adapters/hitch/transport.js'
import { datasetDigest } from '../../src/adapters/hitch/dataset.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { decodeHitchTrials } from '../../src/adapters/hitch/evidence.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { resolveProjectObjective } from '../../src/application/objective.js'
import { validateProfile } from '../../src/application/profile-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const request: OperationRequest = {
  runId: 'run',
  operationId: canonicalDigest('operation'),
  generation: 1,
  partition: 'seed',
  repetitions: 1,
  slots: [{ taskId: 'a', repetition: 0 }],
  evidence: [],
  operation: {
    kind: 'evaluate_seed',
    candidate_id: 'anchor',
    parent_id: null,
    task_ids: ['a'],
    scope: 'global',
    rationale: 'fixture',
    payload: null,
  },
}

it('materializes the Target in the native main context and seals the manifest after mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-context-'))
  roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(executable, `#!${process.execPath}
import { runOrderedHitchFixture } from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};
runOrderedHitchFixture('${canonicalDigest('runtime')}');
`, { mode: 0o700 })
  const adapter = new DshHarnessAdapter(), targets = join(root, 'targets')
  await adapter.prepare(join(targets, 'anchor'))
  const hostPreset = await readFile(join(targets, 'anchor/preset/agent.cordis.yml'), 'utf8')
  let sealed = false
  const provider = await HitchOperationProvider.connect({ kind: 'hitch', executable, root,
    harnessRef: 'deepseek@version:0.1.1-rc.2', model: 'fixture', baseImage: 'python@sha256:' + '1'.repeat(64), passEnv: [], timeoutMs: 3000 }, {
    directory: join(root, 'submissions'), targets, adapter, taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('context-adapter'),
    async compile(destination) {
      await mkdir(join(destination, 'a/environment/candidate'), { recursive: true })
      await mkdir(join(destination, 'a/environment/simulator'))
      await writeFile(join(destination, 'a/environment/candidate/Dockerfile.main'), 'FROM fixture\n')
      await writeFile(join(destination, 'a/environment/simulator/Dockerfile'), 'FROM simulator\n')
      return { environments: { a: { mains: { environment: { context: 'environment/candidate', dockerfile: 'environment/candidate/Dockerfile.main' } } } } }
    },
    async seal(destination, taskIds) {
      expect(taskIds).toEqual(['a'])
      expect(await readFile(join(destination, 'a/environment/candidate/Dockerfile.main'), 'utf8')).toContain('COPY gear-target/')
      const containerPatch = await readFile(join(destination, 'a/environment/candidate/gear-target.patch.yml'), 'utf8')
      expect(containerPatch).toContain('mode: danger-full-access')
      expect(containerPatch).toContain('policy: never')
      expect(await readFile(join(targets, 'anchor/preset/agent.cordis.yml'), 'utf8')).toBe(hostPreset)
      expect(await readFile(join(destination, 'a/environment/simulator/Dockerfile'), 'utf8')).toBe('FROM simulator\n')
      await writeFile(join(destination, 'benchmark.adapter.json'), JSON.stringify({ sealed: true }))
      sealed = true
    },
  })
  await provider.submit(request, new AbortController().signal)
  expect(sealed).toBe(true)
  const directory = join(root, 'submissions', request.operationId.slice(7), 'dataset-0')
  const plan = JSON.parse(await readFile(join(directory, '../plan.json'), 'utf8'))
  expect(plan.groups[0].digest).toBe(await datasetDigest(directory))
  await writeFile(join(directory, 'benchmark.adapter.json'), '{}')
  await expect(provider.inspect(request, new AbortController().signal)).rejects.toThrow('Frozen executable benchmark changed')
})

it('includes native dependency and dotfile content when sealing datasets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-dataset-'))
  roots.push(root)
  await mkdir(join(root, 'task/environment/node_modules/package'), { recursive: true })
  await mkdir(join(root, 'task/environment/.git'))
  await writeFile(join(root, 'task/environment/node_modules/package/index.js'), 'one')
  await writeFile(join(root, 'task/environment/.git/config'), 'one')
  const first = await datasetDigest(root)
  await writeFile(join(root, 'task/environment/node_modules/package/index.js'), 'two')
  const second = await datasetDigest(root)
  expect(second).not.toBe(first)
  await writeFile(join(root, 'task/environment/.git/config'), 'two')
  expect(await datasetDigest(root)).not.toBe(second)
})

it('reconciles lost Hitch submission replies without duplicating physical jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-adapter-'))
  roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(join(root, 'remote.json'), JSON.stringify({ loseSubmitReply: true }))
  await writeFile(
    executable,
    `#!${process.execPath}
import { runOrderedHitchFixture } from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};
runOrderedHitchFixture('${canonicalDigest('runtime')}');
`,
    { mode: 0o700 },
  )
  const adapter = new DshHarnessAdapter(),
    targets = join(root, 'targets')
  await adapter.prepare(join(targets, 'anchor'))
  const provider = await HitchOperationProvider.connect(
    {
      kind: 'hitch',
      executable,
      root,
      harnessRef: 'deepseek@version:0.1.1-rc.2',
      model: 'fixture',
      baseImage: 'python@sha256:' + '1'.repeat(64),
      passEnv: [],
      timeoutMs: 3000,
    },
    {
      directory: join(root, 'submissions'),
      targets,
      adapter,
      taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('adapter'),
      async compile(destination, taskIds) {
        for (const id of taskIds) {
          await mkdir(join(destination, id, 'environment/inputs'), { recursive: true })
          await writeFile(join(destination, id, 'environment/Dockerfile'), 'FROM fixture')
        }
      },
    },
  )
  await expect(provider.submit(request, new AbortController().signal)).rejects.toThrow('did not complete')
  const result = await provider.inspect(request, new AbortController().signal)
  expect(result.state).toBe('complete')
  if (result.state !== 'complete') throw new Error('not complete')
  expect(result.receipt.evidence[0]?.score).toBe(0)
  expect(result.receipt.physicalAttempts).toBe(1)
  expect(JSON.parse(await readFile(join(root, 'remote.json'), 'utf8')).jobs).toBe(1)
  const dataset = join(
    root,
    'submissions',
    request.operationId.slice(7),
    'dataset-0/a/environment/Dockerfile',
  )
  expect(await readFile(dataset, 'utf8')).toContain('FROM fixture\nCOPY gear-target/')
  const inputs = join(dataset, '../inputs')
  await rm(inputs, { recursive: true })
  await expect(provider.inspect(request, new AbortController().signal)).rejects.toThrow(
    'Frozen executable benchmark changed',
  )
  await mkdir(inputs)
  await writeFile(dataset, 'CHANGED')
  await expect(provider.inspect(request, new AbortController().signal)).rejects.toThrow(
    'Frozen executable benchmark changed',
  )
})

it('rejects missing/duplicate slots and keeps verifier failures distinct from valid zero', () => {
  const base = {
    schema_version: '1',
    status: 'failed',
    trials: [
      {
        task_id: 'a',
        attempt: 1,
        run_id: 'run_1',
        observation_status: 'invalid',
        invalid_reason: 'verifier failure',
      },
    ],
  }
  expect(decodeHitchTrials(base, request, ['a'], 0).evidence[0]).toMatchObject({
    status: 'scoring_failed',
    score: null,
  })
  expect(() => decodeHitchTrials({ ...base, trials: [] }, request, ['a'], 0)).toThrow('missing')
  expect(() =>
    decodeHitchTrials({ ...base, trials: [...base.trials, ...base.trials] }, request, ['a'], 0),
  ).toThrow('duplicate')
})

it('projects only certified declared raw metrics and preserves their original evidence', () => {
  const objective = resolveProjectObjective({
    objective: { metric: 'pass_rate' },
    metrics: [
      {
        id: 'process_quality',
        revision: '1',
        unit: 'points',
        direction: 'maximize',
        source: { path: 'originalResult.process_quality', extractor: 'number-v1' },
        granularity: 'trial',
        repetitionReducer: 'mean',
        taskReducer: 'weighted-mean',
        comparisonPrecision: 1e-9,
      },
    ],
  })
  const input = {
    schema_version: '1',
    status: 'succeeded',
    trials: [
      {
        task_id: 'a',
        attempt: 1,
        run_id: 'run_1',
        observation_status: 'valid',
        reward: 1,
        process_quality: 0,
      },
    ],
  }
  const decode = (value: Record<string, unknown>) =>
    decodeHitchTrials(value, { ...request, metrics: objective.metrics }, ['a'], 0)
  expect(decode(input).evidence[0]?.raw_metrics).toMatchObject({
    pass_rate: { status: 'available', value: 1 },
    process_quality: { status: 'available', value: 0, evidenceRefs: [canonicalDigest(input.trials[0])] },
  })
  expect(decode(input).provenance).toEqual(input)
  const { process_quality: _omitted, ...missing } = input.trials[0]!
  expect(decode({ ...input, trials: [missing] }).evidence[0]?.raw_metrics?.process_quality?.status).toBe(
    'missing',
  )
  expect(
    decode({ ...input, trials: [{ ...input.trials[0]!, observation_status: 'invalid' }] }).evidence[0]
      ?.raw_metrics?.process_quality?.status,
  ).toBe('invalid')
})

it('completes original Hitch artifact fields without submitting again, freezes the projection and rejects rewritten outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-projection-'))
  roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(
    executable,
    `#!${process.execPath}
import { runOrderedHitchFixture } from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};
runOrderedHitchFixture('${canonicalDigest('runtime')}');
`,
    { mode: 0o700 },
  )
  const adapter = new DshHarnessAdapter(),
    targets = join(root, 'targets')
  await adapter.prepare(join(targets, 'anchor'))
  const provider = await HitchOperationProvider.connect(
    {
      kind: 'hitch',
      executable,
      root,
      harnessRef: 'deepseek@version:0.1.1-rc.2',
      model: 'fixture',
      baseImage: 'python@sha256:' + '1'.repeat(64),
      passEnv: [],
      timeoutMs: 3000,
    },
    {
      directory: join(root, 'submissions'),
      targets,
      adapter,
      taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('adapter'),
      async compile(destination, taskIds) {
        for (const id of taskIds) {
          await mkdir(join(destination, id, 'environment'), { recursive: true })
          await writeFile(join(destination, id, 'environment/Dockerfile'), 'FROM fixture\n')
        }
      },
    },
  )
  const metrics = resolveProjectObjective({
    objective: { metric: 'pass_rate' },
    metrics: [
      {
        id: 'process_quality',
        revision: '1',
        unit: 'points',
        direction: 'maximize',
        source: { path: 'originalResult.process_quality', extractor: 'number-v1' },
        granularity: 'trial',
        repetitionReducer: 'mean',
        taskReducer: 'weighted-mean',
        comparisonPrecision: 1e-9,
      },
    ],
  }).metrics
  const execution = { ...request, metrics },
    signal = new AbortController().signal
  const original = await provider.submit(execution, signal)
  expect(original.evidence[0]!.raw_metrics!.process_quality!.status).toBe('missing')
  const projection = {
    rootOperationId: execution.operationId,
    rootRequestDigest: canonicalDigest(execution),
    rootProvenanceDigest: canonicalDigest(original.provenance),
    sourceOperationId: execution.operationId,
    sourceReceiptDigest: canonicalDigest(original),
    attempt: 1,
    missing: [{ taskId: 'a', repetition: 0, metrics: ['process_quality'] }],
  }
  const planned: OperationRequest = {
    ...execution,
    evidence: structuredClone(original.evidence),
    projection,
    operationId: canonicalDigest(['run', 'evidence-projection', projection, execution.slots]),
  }
  expect(await provider.inspect(planned, signal)).toEqual({ state: 'not_submitted' })
  const state = JSON.parse(await readFile(join(root, 'remote.json'), 'utf8'))
  await writeFile(join(root, 'remote.json'), JSON.stringify({ ...state, quality: 0,
    inspectionMutations: [{ path: ['request', 'agent_args'], value: ['--patch', '/changed.yml'] }] }))
  await expect(provider.completeEvidence(planned, signal)).rejects.toMatchObject({
    code: 'hitch-result-identity',
  })
  await writeFile(join(root, 'remote.json'), JSON.stringify({ ...state, quality: 0, reward: 1 }))
  await expect(provider.completeEvidence(planned, signal)).rejects.toMatchObject({
    code: 'hitch-projection-source-changed',
  })
  await writeFile(join(root, 'remote.json'), JSON.stringify({ ...state, quality: 0 }))
  const projected = await provider.completeEvidence(planned, signal)
  expect((projected.provenance as Record<string, unknown>).execution_environment).toEqual(provider.executionEnvironment)
  expect((original.provenance as Record<string, unknown>).execution_environment).toEqual(provider.executionEnvironment)
  expect((projected.provenance as Record<string, unknown>).execution_artifacts).toEqual((original.provenance as Record<string, unknown>).execution_artifacts)
  expect((original.provenance as { execution_artifacts: unknown[] }).execution_artifacts).toHaveLength(1)
  expect(projected.physicalAttempts).toBe(0)
  expect(projected.usage.model_requests).toBe(0)
  expect(projected.evidence[0]!.raw_metrics!.process_quality).toMatchObject({ status: 'available', value: 0 })
  expect(projected.evidence[0]!.score).toBe(0)
  expect(projected.evidence[0]!.raw_metrics!.pass_rate).toEqual(original.evidence[0]!.raw_metrics!.pass_rate)
  await writeFile(join(root, 'remote.json'), JSON.stringify({ ...state, quality: 99 }))
  expect(await provider.inspect(planned, signal)).toEqual({ state: 'complete', receipt: projected })
  expect(await provider.completeEvidence(planned, signal)).toEqual(projected)
  expect(await provider.inspect(execution, signal)).toEqual({ state: 'complete', receipt: original })
  expect(JSON.parse(await readFile(join(root, 'remote.json'), 'utf8')).submissions).toBe(1)
  await expect(provider.submit(planned, signal)).rejects.toMatchObject({
    code: 'projection-execution-forbidden',
  })
  await expect(
    provider.completeEvidence(
      { ...planned, projection: { ...projection, rootProvenanceDigest: canonicalDigest('foreign') } },
      signal,
    ),
  ).rejects.toMatchObject({ code: 'hitch-projection-source' })
})

it('projects independent assertions from the original trial without inferring them from reward', () => {
  const objective = resolveProjectObjective({
    objective: { metric: 'pass_rate' },
    assertions: [
      {
        id: 'independent',
        revision: '1',
        source: { path: 'originalResult.assertions.independent', extractor: 'assertion-status-v1' },
      },
    ],
  })
  const evaluate = { ...request, assertions: objective.assertions! }
  const trial = {
    task_id: 'a',
    attempt: 1,
    run_id: 'raw-run',
    observation_status: 'valid',
    reward: 1,
    assertions: { independent: 'failed' },
  }
  const result = { schema_version: '1', status: 'succeeded', trials: [trial] }
  const decoded = decodeHitchTrials(result, evaluate, ['a'], 0)
  expect(decoded.evidence[0]!.score).toBe(1)
  expect(decoded.evidence[0]!.assertions).toEqual([
    {
      id: 'independent',
      schemaDigest: objective.assertions![0]!.digest,
      status: 'failed',
      evidenceRefs: [canonicalDigest(trial)],
    },
  ])
  expect(decoded.provenance).toEqual(result)
  delete (trial as Partial<typeof trial>).assertions
  expect(decodeHitchTrials(result, evaluate, ['a'], 0).evidence[0]!.assertions?.[0]?.status).toBe('missing')
})

async function controlledProvider(initial: Record<string, unknown> = {}, options: { maxConcurrent?: number; setupTimeoutMs?: number; preparationTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-ordered-hitch-'))
  roots.push(root)
  const executable = join(root, 'hitch.mjs'),
    remote = join(root, 'remote.json')
  await writeFile(remote, JSON.stringify(initial))
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};\nrunOrderedHitchFixture('${canonicalDigest('runtime')}');\n`,
    { mode: 0o700 },
  )
  const adapter = new DshHarnessAdapter(),
    targets = join(root, 'targets')
  await adapter.prepare(join(targets, 'anchor'))
  const provider = await HitchOperationProvider.connect(
    {
      kind: 'hitch',
      executable,
      root,
      harnessRef: 'deepseek@version:0.1.1-rc.2',
      model: 'fixture',
      baseImage: 'python@sha256:' + '1'.repeat(64),
      passEnv: [],
      timeoutMs: 3000,
      ...options,
    },
    {
      directory: join(root, 'submissions'),
      targets,
      adapter,
      taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('ordered-adapter'),
      async compile(destination, ids) {
        for (const id of ids) {
          await mkdir(join(destination, id, 'environment'), { recursive: true })
          await writeFile(join(destination, id, 'environment/Dockerfile'), 'FROM fixture')
        }
      },
    },
  )
  return {
    provider,
    remote,
    state: async () => JSON.parse(await readFile(remote, 'utf8')),
    signal: new AbortController().signal,
  }
}
const repeatedRequest = (): OperationRequest => ({
  ...structuredClone(request),
  repetitions: 2,
  slots: [
    { taskId: 'a', repetition: 0 },
    { taskId: 'a', repetition: 1 },
  ],
})

it('submits configured concurrency and setup budgets and allows preparation during admission', async () => {
  const calls = vi.spyOn(hitchTransport, 'hitchJson')
  try {
    const settings = { maxConcurrent: 16, setupTimeoutMs: 2000, preparationTimeoutMs: 123456 }
    const f = await controlledProvider({}, settings)
    await f.provider.submit(request, f.signal)
    expect((await f.state()).job.request).toMatchObject({ max_concurrent: 16, setup_timeout_ms: 2000 })
    const submission = calls.mock.calls.find((call) => call[2][0] === 'eval' && call[2][1] === 'submit')
    const binding = calls.mock.calls.find((call) => call[2][0] === 'eval' && call[2][1] === 'bind')
    expect(submission?.[4]).toBe(settings.preparationTimeoutMs)
    expect(binding?.[4]).toBe(settings.preparationTimeoutMs)
    expect(f.provider.profile).toMatchObject(settings)
  } finally {
    calls.mockRestore()
  }
})

it.each([undefined, 4])('submits and accepts the configured Hitch concurrency %s', async (maxConcurrent) => {
  const f = await controlledProvider({}, maxConcurrent === undefined ? {} : { maxConcurrent })
  expect(validateProfile(f.provider.profile)).toEqual(f.provider.profile)
  const receipt = await f.provider.submit(request, f.signal)
  expect(receipt.physicalAttempts).toBe(1)
  expect((await f.state()).job.request.max_concurrent).toBe(maxConcurrent ?? 1)
  expect(await f.provider.inspect(request, f.signal)).toMatchObject({ state: 'complete' })
})

it('binds concurrency to provider identity and rejects a downgraded execution', async () => {
  const f = await controlledProvider({ inspectionMutations: [{ path: ['request', 'max_concurrent'], value: 1 }] }, { maxConcurrent: 4 })
  const sequential = await HitchOperationProvider.connect({ ...f.provider.profile, maxConcurrent: 1 }, f.provider.context)
  expect(sequential.identity).not.toBe(f.provider.identity)
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-result-identity' })
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([0, -1, 1.5, '4', null, true, Number.MAX_SAFE_INTEGER + 1])('rejects invalid Hitch profile concurrency %s', (maxConcurrent) => {
  expect(() => validateProfile({
    kind: 'hitch', executable: '/bin/hitch', root: '/tmp/hitch',
    harnessRef: 'deepseek@version:0.1.5-rc.3', model: 'fixture',
    baseImage: 'python@sha256:' + '1'.repeat(64), passEnv: [], timeoutMs: 3000, maxConcurrent,
  })).toThrow(expect.objectContaining({ code: 'invalid-profile' }))
})

it.each([
  { path: ['plan', 'controller_runtime', 'runtime_id'], value: canonicalDigest('another-controller') },
  { path: ['execution_plan', 'provider'], value: 'another-provider' },
  { path: ['result', 'candidate', 'model'], value: 'another-model' },
  { path: ['request', 'model'], value: 'another-model' },
  { path: ['request', 'environment_binding'], value: 'hmac-sha256:' + 'e'.repeat(64) },
  { path: ['request', 'environment_binding'], value: null },
  { path: ['request', 'artifact_pins'], value: null },
  { path: ['request', 'artifact_pins'], value: [] },
  { path: ['request', 'artifact_pins', 0, 'artifact_id'], value: canonicalDigest('wrong-artifact') },
  { path: ['request', 'artifact_pins', 0, 'artifact_integrity'], value: canonicalDigest('wrong-files') },
  { path: ['request', 'artifact_pins', 0, 'entrypoint_integrity'], value: canonicalDigest('wrong-launcher') },
  { path: ['request', 'artifact_pins', 0, 'platform'], value: 'linux-x64' },
  { path: ['request', 'agent_args'], value: ['--patch', '/unsealed.yml'] },
  { path: ['request', 'pass_env'], value: ['EXTRA_API_KEY'] },
  { path: ['request', 'attempts'], value: 2 },
  { path: ['request', 'max_concurrent'], value: 2 },
  { path: ['request', 'infrastructure_retries'], value: 1 },
  { path: ['request', 'timeout_ms'], value: 9999 },
  { path: ['request', 'setup_timeout_ms'], value: 9999 },
  { path: ['request', 'harness_ref'], value: 'pi@version:0.84.1' },
  { path: ['request'], value: null },
  { path: ['resolution', 'identity'], value: canonicalDigest('different-runtime') },
  { path: ['result', 'candidate', 'harness_id'], value: 'pi' },
  { path: ['result', 'candidate', 'harness_ref'], value: 'deepseek@version:9.0.0' },
  { path: ['result', 'candidate', 'requested_harness_ref'], value: 'deepseek@version:9.0.0' },
  { path: ['request', 'local_inference'], value: { inference_id: 'unrequested' } },
  { path: ['request', 'training_binding'], value: { kind: 'unrequested' } },
])('rejects Hitch evidence with changed execution conditions: $path', async (mutation) => {
  const f = await controlledProvider({ inspectionMutations: [mutation] })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-result-identity' })
  await expect(f.provider.inspect(request, f.signal)).rejects.toMatchObject({ code: 'hitch-result-identity' })
  expect((await f.state()).submissions).toBe(1)
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('fences all repetitions before preparation and rejects a delayed first submit', async () => {
  const f = await controlledProvider(),
    execution = repeatedRequest()
  await f.provider.cancel(execution)
  expect(Object.values((await f.state()).controls)).toEqual([
    expect.objectContaining({ action: 'pause', sequence: 1 }),
    expect.objectContaining({ action: 'pause', sequence: 1 }),
  ])
  await expect(f.provider.submit(execution, f.signal)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  const state = await f.state()
  expect(state.jobs ?? 0).toBe(0)
  expect(state.commands.filter((row: { action: string }) => row.action === 'submit')).toHaveLength(0)
})

it('inspects a partial batch without submitting it and resumes only its missing repetition', async () => {
  const f = await controlledProvider({ loseSubmitReply: true }),
    execution = repeatedRequest()
  await expect(f.provider.submit(execution, f.signal)).rejects.toThrow('did not complete')
  expect(await f.provider.inspect(execution, f.signal)).toEqual({ state: 'resumable' })
  expect((await f.state()).submissions).toBe(1)
  const receipt = await f.provider.submit(execution, f.signal)
  expect(receipt.physicalAttempts).toBe(2)
  expect(receipt.evidence.map((row) => row.repetition)).toEqual([0, 1])
  expect((await f.state()).jobs).toBe(2)
  expect((await f.state()).submissions).toBe(2)
})

it('replays a lost pause acknowledgment without resubmitting accepted work', async () => {
  const f = await controlledProvider({ loseSubmitReply: true, losePauseReply: true })
  await expect(f.provider.submit(request, f.signal)).rejects.toThrow('did not complete')
  await expect(f.provider.cancel(request)).rejects.toMatchObject({ code: 'hitch-cancellation-unconfirmed' })
  expect((await f.state()).submissions).toBe(1)
  await f.provider.cancel(request)
  await expect(f.provider.submit(request, f.signal)).rejects.toThrow('did not complete')
  const state = await f.state()
  expect(state.jobs).toBe(1)
  expect(state.submissions).toBe(1)
  expect(Object.values(state.jobsById)).toEqual([expect.objectContaining({ state: 'cancelled' })])
})

it('keeps cancellation unconfirmed while the daemon still reports active execution leases', async () => {
  const f = await controlledProvider({ loseSubmitReply: true, cancelPending: true })
  await expect(f.provider.submit(request, f.signal)).rejects.toThrow('did not complete')
  await expect(f.provider.cancel(request)).rejects.toMatchObject({ code: 'hitch-cancellation-unconfirmed' })
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), cancelPending: false }))
  await f.provider.cancel(request)
  expect((await f.state()).submissions).toBe(1)
})

it('rejects verifier-only API keys in the Target credential scope before connecting', async () => {
  await expect(HitchOperationProvider.connect({
    kind: 'hitch', executable: '/must-not-run', root: '/unused', harnessRef: 'deepseek@version:1.0.0',
    model: 'fixture', baseImage: `python@sha256:${'1'.repeat(64)}`, timeoutMs: 1000,
    passEnv: ['GEAR_SCORER_TEST_API_KEY'],
  }, {
    directory: '/unused', targets: '/unused', adapter: new DshHarnessAdapter(),
    taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('fixture'), compile: async () => ({}),
  })).rejects.toMatchObject({ code: 'verifier-credential-target' })
})

it('captures verified seed trajectory digests once and leaves held-out artifacts private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-traces-')); roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(executable, `#!${process.execPath}
import {writeFile,access} from 'node:fs/promises';import {join} from 'node:path';
import {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};
import {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};
const args=process.argv.slice(2);
if(args.includes('capabilities')) process.stdout.write(JSON.stringify({schema_version:'1',ordered_eval_control:'2',controller_runtime_observation:'2',local_execution_observation:'2',evaluation_environment_binding:'3',evaluation_preparation:'1',evaluation_artifact_pins:'1',trajectory_events_page:'1'}));
else if(args.includes('trajectory')) {
 const file=join(args[1],args[args.indexOf('events')+1]+'.json');
 try {await access(file)} catch {await writeFile(file,JSON.stringify([{seq:0,type:'assistant/message',data:'seed execution'}]))}
 await trajectoryFixture();
} else runOrderedHitchFixture('${canonicalDigest('runtime')}');
`, { mode: 0o700 })
  const adapter = new DshHarnessAdapter(), targets = join(root, 'targets')
  await adapter.prepare(join(targets, 'anchor'))
  const provider = await HitchOperationProvider.connect({ kind: 'hitch', executable, root,
    harnessRef: 'deepseek@version:0.1.1-rc.2', model: 'fixture', baseImage: 'python@sha256:' + '1'.repeat(64), passEnv: [], timeoutMs: 3000 }, {
    directory: join(root, 'submissions'), targets, adapter, taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('adapter'),
    async compile(destination, taskIds) { for (const id of taskIds) { await mkdir(join(destination, id, 'environment'), { recursive: true }); await writeFile(join(destination, id, 'environment/Dockerfile'), 'FROM fixture') } },
  })
  const receipt = await provider.submit(request, new AbortController().signal)
  expect(provider.artifactReader?.format).toBe('hitch-canonical-events-v1')
  expect(receipt.artifacts).toEqual([{ kind: 'trajectory', format: 'hitch-canonical-events-v1', task_id: 'a', repetition: 0, status: 'available', content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), locator: { run_id: expect.stringMatching(/^run_[a-f0-9]{32}$/), native_manifest_digest: null }, reason: null }])
  const calls = await readFile(join(root, 'calls.jsonl'), 'utf8')
  expect(await provider.inspect(request, new AbortController().signal)).toEqual({ state: 'complete', receipt })
  const heldOut = await provider.submit({ ...request, partition: 'held_out', operationId: canonicalDigest('held-out') }, new AbortController().signal)
  expect(heldOut.artifacts).toBeUndefined()
  expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe(calls)
  await writeFile(join(root, 'mode'), 'wrong-run')
  const unavailable = await provider.submit({ ...request, operationId: canonicalDigest('second-evaluation') }, new AbortController().signal)
  expect(unavailable.artifacts?.[0]).toMatchObject({ status: 'unavailable', content_digest: null, reason: 'trajectory-source-unavailable' })
  expect(unavailable.evidence[0]?.score).toBe(0)
})


it.each(['controllerId', 'harborDigest', 'engineId'])('binds observed %s bytes to provider identity and rejects drift before submission', async (field) => {
  const f = await controlledProvider()
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), [field]: canonicalDigest('changed') }))
  const changed = await HitchOperationProvider.connect(f.provider.profile, f.provider.context)
  expect(changed.identity).not.toBe(f.provider.identity)
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-environment-drift' })
  expect((await f.state()).submissions ?? 0).toBe(0)
  await f.provider.cancel(request)
  expect(Object.values((await f.state()).controls)).toEqual([expect.objectContaining({ action: 'pause' })])
})
it('keeps identity stable across fresh challenges and daemon restarts with the same measured payload', async () => {
  const f = await controlledProvider()
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), daemonInstance: 'c'.repeat(32) }))
  const same = await HitchOperationProvider.connect(f.provider.profile, f.provider.context)
  expect(same.identity).toBe(f.provider.identity)
})
it.each([
  { path: ['nonce'], value: 'f'.repeat(32), code: 'provider-observation-mismatch' },
  { path: ['daemon_instance_id'], value: 'f'.repeat(32), code: 'provider-observation-mismatch' },
  { path: ['environment_digest'], value: canonicalDigest('wrong'), code: 'provider-environment-drift' },
  { path: ['daemon_runtime', 'unchanged'], value: false, code: 'daemon-runtime-drift' },
])('rejects invalid fresh worker evidence $path', async ({ code, ...mutation }) => {
  await expect(controlledProvider({ observationMutations: [mutation] })).rejects.toMatchObject({ code })
})
it('rejects environment drift before saving a recovered receipt and still cancels admitted work', async () => {
  const f = await controlledProvider({ loseSubmitReply: true })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), engineId: 'replacement-engine' }))
  await expect(f.provider.inspect(request, f.signal)).rejects.toMatchObject({ code: 'hitch-environment-drift' })
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await f.provider.cancel(request)
  expect((await f.state()).submissions).toBe(1)
})


it.each([
  { path: ['result', 'prepared_artifact', 'artifact_id'], value: canonicalDigest('other-dependencies') },
  { path: ['result', 'prepared_artifacts', 0, 'artifact_integrity'], value: canonicalDigest('other-files') },
  { path: ['plan', 'prepared_artifacts', 0, 'entrypoint_integrity'], value: canonicalDigest('other-entrypoint') },
  { path: ['result', 'prepared_artifacts', 0, 'revision_identity'], value: canonicalDigest('other-revision') },
  { path: ['result', 'prepared_artifacts', 0, 'harness_id'], value: 'pi' },
  { path: ['result', 'prepared_artifacts', 0, 'task_ids'], value: ['other-task'] },
  { path: ['result', 'prepared_artifacts', 0, 'runtime_contract', 'docker_platform'], value: 'linux/amd64' },
  { path: ['result', 'prepared_artifacts', 0, 'storage'], value: 'host-artifact-store-v1' },
  { path: ['result', 'prepared_artifacts'], value: [] },
  { path: ['execution_plan', 'work_items', 0, 'artifact_id'], value: canonicalDigest('other-work-artifact') },
  { path: ['execution_plan', 'work_items', 0, 'task_ids'], value: ['other-task'] },
  { path: ['execution_plan', 'work_items', 0, 'runtime_contract', 'node_version'], value: 'v24.0.0' },
])('rejects inconsistent prepared Target artifact evidence: $path', async (mutation) => {
  const f = await controlledProvider({ inspectionMutations: [mutation] })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
  expect((await f.state()).submissions).toBe(1)
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects different prepared dependencies between repetitions without repeating physical work', async () => {
  const f = await controlledProvider({ ignoreArtifactPins: true, artifactIds: [canonicalDigest('closure-a'), canonicalDigest('closure-b')] })
  const execution = repeatedRequest()
  await expect(f.provider.submit(execution, f.signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
  await expect(f.provider.inspect(execution, f.signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
  expect((await f.state()).submissions).toBe(2)
  await expect(readFile(join(f.provider.context.directory, execution.operationId.slice(7), 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})


it('freezes dependency identity before admission and rejects drift before any physical submission', async () => {
  const f = await controlledProvider()
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), preparedArtifactId: canonicalDigest('changed-dependencies') }))
  const changed = await HitchOperationProvider.connect(f.provider.profile, f.provider.context)
  expect(changed.identity).not.toBe(f.provider.identity)
  expect(changed.preparedArtifacts).not.toEqual(f.provider.preparedArtifacts)
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
  expect((await f.state()).submissions ?? 0).toBe(0)
})
it('rejects a mutually consistent result and plan when they differ from the pre-admission artifact', async () => {
  const f = await controlledProvider()
  // Preparation still verifies the original local cache; the daemon reports a different complete artifact.
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), ignoreArtifactPins: true, artifactIds: [canonicalDigest('remote-dependencies')], preparedArtifactId: f.provider.preparedArtifacts[0]!.artifact.artifact_id }))
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
  expect((await f.state()).submissions).toBe(1)
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('submits immutable artifact pins so daemon dependency drift is rejected before physical work', async () => {
  const f = await controlledProvider()
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), artifactIds: [canonicalDigest('remote-dependencies')], preparedArtifactId: f.provider.preparedArtifacts[0]!.artifact.artifact_id }))
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  const state = await f.state()
  expect(state.pinRejections).toBe(1)
  expect(state.submissions ?? 0).toBe(0)
  expect(state.jobs ?? 0).toBe(0)
  await expect(readFile(join(f.provider.context.directory, request.operationId.slice(7), 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reconnects only the frozen cancellation protocol after runtime and dependencies drift', async () => {
  const f = await controlledProvider({ loseSubmitReply: true })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), engineId: 'changed-engine', preparedArtifactId: canonicalDigest('changed-closure') }))
  // Normal connection and preparation must now fail; the stop protocol still owns the old subject.
  await writeFile(f.provider.profile.executable, `#!${process.execPath}\nimport {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};if(process.argv[4]!=='eval')process.exit(1);runOrderedHitchFixture('${canonicalDigest('runtime')}');`, { mode: 0o700 })
  const cancel = await configuredCancellation(f.provider.cancellation)
  await cancel.cancel(request)
  const state = await f.state()
  expect(state.jobs).toBe(1)
  expect(state.submissions).toBe(1)
  expect(Object.values(state.jobsById)).toEqual([expect.objectContaining({ state: 'cancelled' })])
  expect(Object.values(state.controls)).toEqual([expect.objectContaining({ sequence: 1, action: 'pause' })])
})

it('binds the resident model environment before admission and refuses a changed source before submission', async () => {
  const f = await controlledProvider()
  await writeFile(f.remote, JSON.stringify({ ...(await f.state()), environmentBinding: 'hmac-sha256:' + 'e'.repeat(64) }))
  const changed = await HitchOperationProvider.connect(f.provider.profile, f.provider.context)
  expect(changed.identity).not.toBe(f.provider.identity)
  expect(changed.environmentBinding.binding_id).not.toBe(f.provider.environmentBinding.binding_id)
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-call-failed' })
  expect((await f.state()).submissions ?? 0).toBe(0)
})


it.each([false, true])('preserves a terminal Hitch failure and partial evidence (legacy identity: %s)', async (legacy) => {
  const f = await controlledProvider({ failedResult: { trials: [] },
    ...(legacy ? { omittedResultFields: ['dataset', 'candidate', 'prepared_artifact', 'prepared_artifacts'] } : {}) })
  const receipt = await f.provider.submit(request, f.signal)
  expect(receipt.result).toMatchObject({ status: 'failed', data: { errors: [{ code: 'environment_image_evidence_unavailable' }] } })
  expect(receipt.evidence).toEqual([expect.objectContaining({ task_id: 'a', score: null, status: 'environment_failed' })])
  expect(receipt.physicalAttempts).toBe(1)
  expect(await f.provider.inspect(request, f.signal)).toEqual({ state: 'complete', receipt })
  expect((await f.state()).submissions).toBe(1)
  const source = (receipt.provenance as { evaluations: Array<Record<string, unknown>> }).evaluations[0]!
  expect(source.trials).toEqual([])
  if (legacy) expect(source).not.toHaveProperty('candidate')
})

it('retains certified zero scores and the upstream error on a failed Hitch evaluation', async () => {
  const f = await controlledProvider({ failedResult: {} })
  const receipt = await f.provider.submit(request, f.signal)
  expect(receipt.result.status).toBe('failed')
  expect(receipt.evidence[0]).toMatchObject({ status: 'valid', score: 0 })
  expect(receipt.result.data).toMatchObject({ errors: [{ code: 'environment_image_evidence_unavailable' }] })
})

it.each([
  { path: ['request', 'model'], value: 'wrong-model' },
  { path: ['plan', 'candidate', 'model'], value: 'wrong-model' },
  { path: ['result', 'dataset'], value: 'wrong-dataset' },
  { path: ['result', 'candidate'], value: null },
  { path: ['result', 'prepared_artifacts'], value: [] },
])('still rejects changed identities in a failed Hitch evaluation: $path', async (mutation) => {
  const f = await controlledProvider({ failedResult: {}, inspectionMutations: [mutation],
    omittedResultFields: ['dataset', 'candidate', 'prepared_artifact', 'prepared_artifacts'] })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({
    code: mutation.path.includes('prepared_artifacts') ? 'hitch-artifact-identity' : 'hitch-result-identity',
  })
})

it('rejects missing result identities on a successful evaluation', async () => {
  const f = await controlledProvider({ omittedResultFields: ['dataset', 'candidate', 'prepared_artifact', 'prepared_artifacts'] })
  await expect(f.provider.submit(request, f.signal)).rejects.toMatchObject({ code: 'hitch-result-identity' })
})

it('decodes partial failed trials without inventing a score for missing tasks', () => {
  const source = { schema_version: '1', status: 'failed', task_completed: true,
    error: { code: 'environment_image_evidence_unavailable', message: 'Missing container observations' },
    trials: [{ task_id: 'a', attempt: 1, run_id: 'run_1', observation_status: 'valid', reward: 0 }] }
  const decoded = decodeHitchTrials(source, request, ['a', 'b'], 0)
  expect(decoded.evidence).toEqual([
    expect.objectContaining({ task_id: 'a', status: 'valid', score: 0 }),
    expect.objectContaining({ task_id: 'b', status: 'environment_failed', score: null }),
  ])
  expect(decoded.provenance).toEqual(source)
  expect(() => decodeHitchTrials({ ...source, trials: [...source.trials, ...source.trials] }, request, ['a', 'b'], 0)).toThrow('duplicate')
  expect(() => decodeHitchTrials({ ...source, status: 'succeeded' }, request, ['a', 'b'], 0)).toThrow('missing')
})
