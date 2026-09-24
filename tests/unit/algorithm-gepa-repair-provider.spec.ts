import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaRepairEvaluationProvider, type GepaRepairEvaluationInput } from '../../src/algorithm/providers/gepa-repair-evaluation.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { seal } from '../../src/search/contracts.js'
import { plannedCells } from '../../src/search/evidence.js'
import { evaluatedFixture, fixtures, scopeFixture } from '../../src/search/testing.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gepa-repair-provider-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan, result } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const empty = seal({ stagePlanDigest: plan.digest, snapshotDigest: fixture.anchor.digest, cells: [], settled: true })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaRepairEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const missing = plannedCells(fixture.seed, plan, fixture.anchor)
  const input: GepaRepairEvaluationInput = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, repairId: 'repair-a',
    originalRef: artifacts.putJson(empty as unknown as JsonValue, 'gepa.stage-result.v1'),
    currentRef: artifacts.putJson(empty as unknown as JsonValue, 'gepa.stage-result.v1'),
    cachedRef: artifacts.putJson({ schemaVersion: 1, cells: [] }, 'gepa.cached-cells.v1'),
    plan, snapshot: fixture.anchor, universe: fixture.seed, missing, deadlineAt: Date.now() + 60_000 }
  const operationId = digestJson(['repair-operation', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'repair',
    operationId, idempotencyKey: operationId, kind: 'gepa.repair-evaluate',
    input: input as unknown as JsonValue, inputDigest: jsonDigest(input as unknown as JsonValue),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: missing.length, repairCells: missing.length } }
  return { fixture, artifacts, provider, envelope, input, sampleCell: result.cells[0]! }
}

it('resumes a partially complete legacy repair on the same key once per public call', async () => {
  const { fixture, provider, envelope, input, artifacts, sampleCell } = setup()
  const realEvaluate = fixture.provider.evaluate
  const keys: string[] = []
  let ready = false
  fixture.provider.inspectEvaluation = async () => ({ status: 'partially-complete', cells: [sampleCell] })
  fixture.provider.evaluate = async request => {
    keys.push(request.idempotencyKey)
    if (!ready) throw new Error('still running')
    return realEvaluate(request)
  }
  provider.beginLegacyInvocation()
  expect((await provider.submit(envelope)).status).toBe('running')
  expect((await provider.inspect(envelope)).status).toBe('running')
  expect(keys).toHaveLength(1)
  provider.beginLegacyInvocation()
  expect((await provider.inspect(envelope)).status).toBe('replay-safe')
  ready = true
  const completed = await provider.submit(envelope)
  expect(completed.status).toBe('completed')
  const current = artifacts.getJson(input.currentRef) as { digest: string }
  expect(keys).toEqual([digestJson(['r', 'repair-a', current.digest]), digestJson(['r', 'repair-a', current.digest])])
})

it('seals a completed physical inspection after the repair response is lost without a second evaluate', async () => {
  const { fixture, provider, envelope, artifacts } = setup()
  const realEvaluate = fixture.provider.evaluate
  const realInspect = fixture.provider.inspectEvaluation!
  let attempts = 0
  fixture.provider.evaluate = async request => {
    attempts++
    await realEvaluate(request)
    throw new Error('response lost')
  }
  fixture.provider.inspectEvaluation = realInspect
  const submitted = await provider.submit(envelope)
  expect(submitted.status).toBe('completed')
  expect(attempts).toBe(1)
  if (submitted.status !== 'completed' || submitted.completion.outcome.kind !== 'result')
    throw new Error('repair was not sealed')
  const value = submitted.completion.outcome.value as { executionRef: Parameters<typeof artifacts.getJson>[0] }
  expect(artifacts.getJson(value.executionRef)).toMatchObject({ schemaVersion: 1, cells: [{ identity: { taskId: 'task-0' } }] })
})

it('preserves the original repair transport reason and physical handle for public pending compatibility', async () => {
  const { fixture, provider, envelope } = setup()
  fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'frozen-repair-worker' })
  fixture.provider.evaluate = async () => { throw new Error('lost original repair response') }
  const submitted = await provider.submit(envelope)
  expect(submitted).toEqual({ status: 'running', handle: 'frozen-repair-worker' })
  expect(await provider.legacyPending(envelope)).toEqual({ state: 'running', handle: 'frozen-repair-worker',
    reason: 'lost original repair response' })
})

it('starts a zero-cell repair reservation only after preparation and cancels its unstarted intent', async () => {
  const { fixture, provider, envelope, input, artifacts, sampleCell } = setup()
  const current = seal({ stagePlanDigest: input.plan.digest, snapshotDigest: input.snapshot.digest,
    cells: [sampleCell], settled: true })
  const zeroInput: GepaRepairEvaluationInput = { ...input,
    currentRef: artifacts.putJson(current as unknown as JsonValue, 'gepa.stage-result.v1'), missing: [] }
  const zeroEnvelope: OperationEnvelope = { ...envelope, input: zeroInput as unknown as JsonValue,
    inputDigest: jsonDigest(zeroInput as unknown as JsonValue),
    limits: { rolloutCells: 0, repairCells: 0 }, startsBudgetClock: true }
  expect(await provider.prepareForDispatch(zeroEnvelope)).toEqual({ startsBudgetClock: true })
  expect((await provider.inspect(zeroEnvelope)).status).toBe('not-started')
  expect(fixture.executions).toHaveLength(0)
  expect(await provider.cancel(zeroEnvelope)).toMatchObject({ status: 'cancelled', releaseConfirmed: true })
  await expect(provider.submit(zeroEnvelope)).rejects.toThrow('Cancelled GEPA repair')
  expect(fixture.executions).toHaveLength(0)
})
