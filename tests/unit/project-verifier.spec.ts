import { fixtureRuntime } from '../helpers/hitch-runtime-fixture.js'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { builtinPolicy } from '../../src/adapters/python/builtin-policy.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { validateAlgorithmWire } from '../../src/domain/algorithm-schema.js'
import { validateVerifierEvidence } from '../../src/domain/verifier-evidence.js'
import { validateProjectionReceipt } from '../../src/runtime/evidence-projection.js'
import { resolveProjectObjective } from '../../src/application/objective.js'
import type { Evidence, VerifierObservation } from '../../src/domain/algorithm-wire.js'
import type { OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(state: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-verifier-'))
  roots.push(root)
  const executable = join(root, 'hitch.mjs')
  await writeFile(join(root, 'remote.json'), JSON.stringify({ verifier: true, ...state }))
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};runOrderedHitchFixture(${JSON.stringify(canonicalDigest('runtime'))});`,
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
      targets,
      adapter,
      directory: join(root, 'provider'),
      taskIds: ['a'], runtime: fixtureRuntime, implementationIdentity: canonicalDigest('adapter'),
      async compile(destination, ids) {
        for (const id of ids) {
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
        unit: 'ratio',
        direction: 'maximize',
        source: { path: 'verifier.process.score', extractor: 'number-v1' },
        granularity: 'trial',
        repetitionReducer: 'mean',
        taskReducer: 'weighted-mean',
        comparisonPrecision: 1e-9,
      },
    ],
  }).metrics
  const request: OperationRequest = {
    runId: 'run',
    operationId: canonicalDigest('operation'),
    generation: 0,
    partition: 'seed',
    repetitions: 1,
    slots: [{ taskId: 'a', repetition: 0 }],
    evidence: [],
    metrics,
    operation: {
      kind: 'evaluate_seed',
      candidate_id: 'anchor',
      parent_id: null,
      task_ids: ['a'],
      scope: 'global',
      rationale: 'verify',
      payload: null,
    },
  }
  const update = async (change: Record<string, unknown>) => {
    const value = JSON.parse(await readFile(join(root, 'remote.json'), 'utf8'))
    await writeFile(join(root, 'remote.json'), JSON.stringify({ ...value, ...change }))
  }
  return { root, provider, request, update, signal: new AbortController().signal }
}

it('freezes independent verifier channels and keeps private source data outside public evidence', async () => {
  const { provider, request, signal, root, update } = await fixture()
  const receipt = await provider.submit(request, signal),
    cell = receipt.evidence[0]!
  validateAlgorithmWire('OperationReceipt', receipt)
  validateVerifierEvidence(cell)
  expect(cell).toMatchObject({
    score: 0,
    status: 'valid',
    verifier: {
      status: 'available',
      primary_score: 0,
      process: { score: 0.5, passed: 1, total: 2 },
      failure_codes: ['missing-check'],
    },
    raw_metrics: { process_quality: { status: 'available', value: 0.5 } },
  })
  expect(cell.feedback).toContain('hypotheses')
  expect(JSON.stringify(receipt.provenance)).toContain('PRIVATE_VERIFIER_RESULT')
  expect(JSON.stringify(cell)).not.toMatch(/PRIVATE_VERIFIER|private_details_ref|run_[a-f0-9]{32}/)
  await update({ verifierChanged: true })
  expect(await provider.inspect(request, signal)).toEqual({ state: 'complete', receipt })
  const state = JSON.parse(await readFile(join(root, 'remote.json'), 'utf8'))
  expect(state.commands.filter((value: { action: string }) => value.action === 'verifier')).toHaveLength(1)
})

it('retains the valid primary zero when secondary verifier evidence is mismatched or unsupported', async () => {
  for (const state of [{ verifierWrongRun: true }, { verifier: false }]) {
    const { provider, request, signal } = await fixture(state)
    const receipt = await provider.submit(request, signal)
    expect(receipt.evidence[0]).toMatchObject({
      score: 0,
      status: 'valid',
      verifier: {
        status: state.verifier === false ? 'unsupported' : 'invalid',
        process: null,
        failure_codes: [],
      },
      raw_metrics: { process_quality: { status: state.verifier === false ? 'unsupported' : 'invalid' } },
    })
    expect(receipt.physicalAttempts).toBe(1)
  }
})

it('fills declared channels from original verifier material without rewriting historical diagnosis or rerunning a target', async () => {
  const { provider, request, signal, update, root } = await fixture({ verifierUnavailable: true })
  const original = await provider.submit(request, signal)
  const projection = {
    rootOperationId: request.operationId,
    rootRequestDigest: canonicalDigest(request),
    rootProvenanceDigest: canonicalDigest(original.provenance),
    sourceOperationId: request.operationId,
    sourceReceiptDigest: canonicalDigest(original),
    attempt: 1,
    missing: [{ taskId: 'a', repetition: 0, metrics: ['process_quality'] }],
  }
  const planned = {
    ...request,
    evidence: structuredClone(original.evidence),
    projection,
    operationId: canonicalDigest('projection'),
  }
  await update({ verifierUnavailable: false })
  const receipt = await provider.completeEvidence(planned, signal)
  expect(receipt.evidence[0]!.raw_metrics!.process_quality).toMatchObject({ status: 'available', value: 0.5 })
  expect(receipt.evidence[0]!.verifier).toEqual(original.evidence[0]!.verifier)
  expect(receipt.evidence[0]!.feedback).toBe(original.evidence[0]!.feedback)
  expect(receipt.physicalAttempts).toBe(0)
  validateProjectionReceipt(planned, receipt)
  expect(JSON.parse(await readFile(join(root, 'remote.json'), 'utf8')).submissions).toBe(1)
})

it('rejects rewriting a certified process payload even if its claimed source digest is unchanged', async () => {
  const { provider, request, signal, update } = await fixture()
  const original = await provider.submit(request, signal)
  const projection = {
    rootOperationId: request.operationId,
    rootRequestDigest: canonicalDigest(request),
    rootProvenanceDigest: canonicalDigest(original.provenance),
    sourceOperationId: request.operationId,
    sourceReceiptDigest: canonicalDigest(original),
    attempt: 1,
    missing: [{ taskId: 'a', repetition: 0, metrics: ['other'] }],
  }
  await update({ verifierChanged: true })
  await expect(
    provider.completeEvidence(
      { ...request, evidence: original.evidence, projection, operationId: canonicalDigest('projection') },
      signal,
    ),
  ).rejects.toMatchObject({ code: 'hitch-verifier-source-changed' })
})

it('keeps verifier certifications across successive projections of disjoint repetition groups', async () => {
  const { provider, request, signal, update } = await fixture({ verifierUnavailable: true })
  request.repetitions = 2
  request.slots.push({ taskId: 'a', repetition: 1 })
  const original = await provider.submit(request, signal)
  await update({ verifierUnavailable: false })
  const project = (prior: typeof original, repetition: number, attempt: number) => ({
    ...request,
    operationId: canonicalDigest(['projection', attempt]),
    slots: [{ taskId: 'a', repetition }],
    evidence: structuredClone(
      prior.evidence.filter((cell) => cell.repetition === repetition).length
        ? prior.evidence.filter((cell) => cell.repetition === repetition)
        : original.evidence.filter((cell) => cell.repetition === repetition),
    ),
    projection: {
      rootOperationId: request.operationId,
      rootRequestDigest: canonicalDigest(request),
      rootProvenanceDigest: canonicalDigest(original.provenance),
      sourceOperationId: prior.result.operation_id,
      sourceReceiptDigest: canonicalDigest(prior),
      attempt,
      missing: [{ taskId: 'a', repetition, metrics: ['process_quality'] }],
    },
  })
  const first = await provider.completeEvidence(project(original, 0, 1), signal)
  const second = await provider.completeEvidence(project(first, 1, 2), signal)
  const sources = (second.provenance as { verifier_sources: Array<{ observation: { status: string } }> })
    .verifier_sources
  expect(sources).toHaveLength(2)
  expect(sources.every((value) => value.observation.status === 'available')).toBe(true)
  await update({ verifierChanged: true })
  await expect(provider.completeEvidence(project(second, 0, 3), signal)).rejects.toMatchObject({
    code: 'hitch-verifier-source-changed',
  })
})

it('validates closed bounds and rejects facts attached to uncertified evidence', () => {
  const empty = builtinPolicy<VerifierObservation>('verifier_project', { source: null })
  expect(() => validateAlgorithmWire('VerifierObservation', empty)).not.toThrow()
  for (const value of [
    { ...empty, source_digest: 'bad' },
    { ...empty, failure_codes: Array(33).fill('code') },
    { ...empty, failure_codes: ['bad/code'] },
  ])
    expect(() => validateAlgorithmWire('VerifierObservation', value)).toThrow()
  const cell: Evidence = {
    candidate_id: 'c',
    task_id: 't',
    repetition: 0,
    score: null,
    status: 'environment_failed',
    scope: 's',
    feedback: '',
    verifier: {
      ...empty,
      status: 'available',
      reason: null,
      source_digest: canonicalDigest('source'),
      result_digest: canonicalDigest('result'),
      detail_status: 'result_only',
      primary_score: 0,
    },
  }
  expect(() => validateVerifierEvidence(cell)).toThrow('certified trial')
})
