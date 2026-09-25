import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaEvaluationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { seal } from '../../src/search/contracts.js'
import { completeEvidence } from '../../src/search/evidence.js'
import { evaluatedFixture, fixtures, revise, scopeFixture } from '../../src/search/testing.js'
import type { EvidenceCell, StageResult } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(mode: 'complete' | 'incomplete', taskCount = 3) {
  const root = mkdtempSync(join(tmpdir(), 'gepa-projection-linear-')); roots.push(root)
  const fixture = fixtures(4, true)
  const { plan } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0', 'task-1', 'task-2'].slice(0, taskCount)), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const original: EvidenceCell[] = [], projected: EvidenceCell[] = []
  const physicalEvaluate = fixture.provider.evaluate.bind(fixture.provider)
  fixture.provider.evaluate = async request => {
    const cells = (await physicalEvaluate(request)).map(cell => revise(cell, {
      process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'awaiting projection' },
    }))
    original.push(...cells)
    return cells
  }
  fixture.provider.completeProcess = async cell => {
    const replacement = mode === 'incomplete' ? cell : revise(cell, {
      process: { status: 'available', rawValue: 0.5,
        contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef },
    })
    projected.push(replacement)
    return replacement
  }
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'required' } as unknown as JsonValue
  const operationId = digestJson(['projection-linear', mode, root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: taskCount, repairCells: 0 } }
  return { root, fixture, plan, provider, envelope, artifacts, original, projected }
}

it('matches the original sequential completeEvidence stage digest for three physical projections', async () => {
  const { fixture, plan, provider, envelope, artifacts, original, projected } = setup('complete')
  const submission = await provider.submit(envelope)
  expect(submission.status).toBe('completed')
  if (submission.status !== 'completed' || submission.completion.outcome.kind !== 'result')
    throw new Error('missing projected stage')
  const ref = (submission.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }).resultRef
  const actual = artifacts.getJson(ref) as unknown as StageResult
  let cells = original
  for (const replacement of projected) {
    const before = seal({ stagePlanDigest: plan.digest, snapshotDigest: fixture.anchor.digest, cells, settled: true })
    cells = completeEvidence(before, [replacement]).cells
  }
  const expected = seal({ stagePlanDigest: plan.digest, snapshotDigest: fixture.anchor.digest,
    cells, settled: true })
  expect(projected).toHaveLength(3)
  expect(actual).toEqual(expected)
})

it('rejects an incomplete first projection before starting the second physical projection', async () => {
  const { provider, envelope, projected } = setup('incomplete')
  const submission = await provider.submit(envelope)
  expect(submission.status).toBe('completed')
  if (submission.status !== 'completed') throw new Error('missing terminal projection error')
  expect(submission.completion.outcome).toMatchObject({ kind: 'error', code: 'PROCESS_COMPLETION_INCOMPLETE' })
  expect(projected).toHaveLength(1)
})

it('resumes after the second projection loses its response without repeating the first projection or rollout', async () => {
  const { root, fixture, provider, envelope, original, artifacts, plan } = setup('complete', 2)
  const physicalKeys: string[] = []
  const projected: EvidenceCell[] = []
  let lostKey: string | undefined, lostValue: EvidenceCell | undefined, ready = false
  fixture.provider.completeProcess = async (cell, key) => {
    physicalKeys.push(key)
    const value = revise(cell, { process: { status: 'available', rawValue: 0.5,
      contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
    projected.push(value)
    if (physicalKeys.length === 2) { lostKey = key; lostValue = value; throw new Error('lost second projection response') }
    return value
  }
  fixture.provider.inspectProcess = async (_cell, key) => ready && key === lostKey
    ? { status: 'complete', result: { cells: [lostValue!] } }
    : { status: 'running', handle: 'original-projection-worker' }
  const first = await provider.submit(envelope)
  expect(first.status).toBe('running')
  expect(physicalKeys).toHaveLength(2)
  expect(fixture.executions).toHaveLength(1)
  ready = true
  const resumedArtifacts = new FileArtifactStore(join(root, 'artifacts'))
  const resumedBindings = new BindingStore(resumedArtifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const resumed = new GepaEvaluationProvider(join(root, 'operations'), resumedArtifacts,
    resumedBindings, fixture.provider)
  expect(resumed.describe().implementationDigest).toBe(envelope.implementationDigest)
  const settled = await resumed.submit(envelope)
  expect(settled.status).toBe('completed')
  if (settled.status !== 'completed' || settled.completion.outcome.kind !== 'result')
    throw new Error('missing resumed projected stage')
  const ref = (settled.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }).resultRef
  const actual = resumedArtifacts.getJson(ref) as unknown as StageResult
  let cells = original
  for (const replacement of projected) {
    const before = seal({ stagePlanDigest: plan.digest, snapshotDigest: fixture.anchor.digest, cells, settled: true })
    cells = completeEvidence(before, [replacement]).cells
  }
  expect(actual).toEqual(seal({ stagePlanDigest: plan.digest, snapshotDigest: fixture.anchor.digest,
    cells, settled: true }))
  expect(physicalKeys).toHaveLength(2)
  expect(new Set(physicalKeys).size).toBe(2)
  expect(fixture.executions).toHaveLength(1)
})
