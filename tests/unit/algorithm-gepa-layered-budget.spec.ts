import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { OperationEnvelope, ProviderDispatchContext } from '../../src/algorithm/contracts.js'
import { GepaDiagnosisProvider, GepaEvaluationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { captureGepaBudgetCut } from '../../src/algorithm/recipes/gepa-budget.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { cellKey, plannedCells } from '../../src/search/evidence.js'
import { MemorySearchStore, evaluatedFixture, fixtures, scopeFixture, settings } from '../../src/search/testing.js'
import type { StageResult } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = 2_000_000_000_000
const context = (overrides: Partial<ProviderDispatchContext> = {}): ProviderDispatchContext => ({
  dispatchAdmitted: false, spent: {}, reservedExcludingSelf: {}, batchOrdinal: 0, ...overrides,
})

async function setup(options: { cached?: boolean; roundCells?: number; roundDiagnosisInputTokens?: number;
  evolutionTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gepa-layered-budget-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan, result } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 1 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const journal = new MemorySearchStore()
  if (options.cached) for (const cell of result.cells) {
    await journal.put(cell)
    await journal.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
  }
  const limits = settings().budgets
  if (options.roundCells !== undefined) limits.round.maxNewRolloutCells = options.roundCells
  if (options.roundDiagnosisInputTokens !== undefined)
    limits.round.maxDiagnosisInputTokens = options.roundDiagnosisInputTokens
  if (options.evolutionTimeoutMs !== undefined) limits.evolution.timeoutMs = options.evolutionTimeoutMs
  const budgetCut = await captureGepaBudgetCut(journal, 'r', limits)
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings,
    fixture.provider, undefined, undefined, journal)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off', budgetCut, roundStartedAt: now - 100 } as unknown as JsonValue
  const operationId = digestJson(['layered', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input,
    inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
    bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: plannedCells(fixture.seed, plan, fixture.anchor).length, repairCells: 0 },
    startsBudgetClock: true }
  return { root, fixture, artifacts, bindings, harness, baseline: result, budgetCut, provider, journal, envelope }
}

it('uses the frozen cache split: a fully cached evaluation does not start the old reserve clock', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { fixture, provider, envelope } = await setup({ cached: true })
  let physicalCalls = 0
  fixture.provider.evaluate = async () => { physicalCalls++; return [] }
  expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: false })
  const completed = await provider.submit(envelope)
  expect(completed.status).toBe('completed')
  expect(physicalCalls).toBe(0)
  if (completed.status === 'completed') expect(completed.completion.receipt?.cumulative)
    .toEqual({ rolloutCells: 0, repairCells: 0 })
})

it('preserves a round.cells denial as sealed StageResult.failure with zero physical usage', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { fixture, artifacts, provider, envelope } = await setup({ roundCells: 0 })
  let physicalCalls = 0
  fixture.provider.evaluate = async () => { physicalCalls++; return [] }
  expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: false })
  const completed = await provider.submit(envelope)
  expect(completed.status).toBe('completed')
  expect(physicalCalls).toBe(0)
  if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result') return
  const value = completed.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }
  const result = artifacts.getJson(value.resultRef) as unknown as StageResult
  expect(result.failure).toMatchObject({ kind: 'budget-exhausted', code: 'round.cells',
    message: 'search budget exhausted: round.cells' })
  expect(completed.completion.receipt?.cumulative).toEqual({ rolloutCells: 0, repairCells: 0 })
})

it('starts the first reserve clock even if the admission-based evolution run signal has expired', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { fixture, artifacts, provider, envelope } = await setup({ evolutionTimeoutMs: 50 })
  let physicalCalls = 0
  fixture.provider.evaluate = async () => { physicalCalls++; return [] }
  const dispose = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
    deadlineAt: now - 50 })
  try {
    expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: true })
    const completed = await provider.submit(envelope)
    expect(completed.status).toBe('completed')
    expect(physicalCalls).toBe(0)
    if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result') return
    const value = completed.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }
    const result = artifacts.getJson(value.resultRef) as unknown as StageResult
    expect(result.failure).toMatchObject({ kind: 'budget-exhausted', code: 'time' })
    expect(completed.completion.receipt?.cumulative).toEqual({ rolloutCells: 0, repairCells: 0 })
  } finally { dispose() }
})

it('rechecks a prepared-only plan after a failed clock commit, but keeps a durably admitted denial', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { artifacts, provider, envelope } = await setup()
  expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: true })
  vi.spyOn(Date, 'now').mockReturnValue(now + 700_000)
  expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: false })
  expect(await provider.prepareForDispatch(envelope, context({ dispatchAdmitted: true })))
    .toEqual({ startsBudgetClock: false })
  const completed = await provider.submit(envelope)
  if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result') return
  const value = completed.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }
  const result = artifacts.getJson(value.resultRef) as unknown as StageResult
  expect(result.failure).toMatchObject({ kind: 'budget-exhausted', code: 'time' })
})

it('returns a typed zero-usage diagnosis denial without a dossier or physical request', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { root, fixture, artifacts, bindings, harness, baseline, budgetCut, journal } =
    await setup({ roundDiagnosisInputTokens: 0 })
  const provider = new GepaDiagnosisProvider(join(root, 'diagnosis-operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  let physicalCalls = 0
  fixture.diagnosis.diagnose = async () => { physicalCalls++; throw new Error('unexpected physical diagnosis') }
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds: ['task-0'], baseline, budgetCut,
    roundStartedAt: now - 100 } as unknown as JsonValue
  const operationId = digestJson(['diagnosis-layered', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input,
    inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
    bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 100 }, startsBudgetClock: true }
  expect(await provider.prepareForDispatch(envelope, context())).toEqual({ startsBudgetClock: false })
  const completed = await provider.submit(envelope)
  expect(completed.status).toBe('completed')
  expect(physicalCalls).toBe(0)
  if (completed.status === 'completed') {
    expect(completed.completion.outcome).toEqual({ kind: 'error', code: 'SEARCH_BUDGET_EXHAUSTED',
      message: 'search budget exhausted: diagnosisInputTokens', retryable: false })
    expect(completed.completion.receipt?.cumulative).toEqual({ diagnosisInputTokens: 0,
      diagnosisOutputTokens: 0 })
  }
  const name = `diagnosis-${digestJson([fixture.anchor.digest, baseline.digest, ['task-0']]).slice(7)}`
  expect(await journal.read(`rounds/r/${name}-input`)).toBeUndefined()
})

it('freezes diagnosis request caps from the remaining two-layer budget, not the static envelope limit', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const { root, fixture, artifacts, bindings, harness, baseline, budgetCut, journal } =
    await setup({ roundDiagnosisInputTokens: 100 })
  const provider = new GepaDiagnosisProvider(join(root, 'diagnosis-operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  let physicalCap: number | undefined
  fixture.diagnosis.diagnose = async input => {
    physicalCap = input.maxInputTokens
    return { facts: [], inputTokens: 5, outputTokens: 5 }
  }
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds: ['task-0'], baseline, budgetCut,
    roundStartedAt: now - 100 } as unknown as JsonValue
  const operationId = digestJson(['diagnosis-cap', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input,
    inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
    bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 20_000 }, startsBudgetClock: true }
  expect(await provider.prepareForDispatch(envelope, context({
    spent: { diagnosisInputTokens: 30 }, reservedExcludingSelf: {},
  }))).toEqual({ startsBudgetClock: true })
  const completed = await provider.submit(envelope)
  expect(completed.status).toBe('completed')
  expect(physicalCap).toBe(70)
  const name = `diagnosis-${digestJson([fixture.anchor.digest, baseline.digest, ['task-0']]).slice(7)}`
  const pointer = await journal.read<{ ref: string }>(`rounds/r/${name}-input`)
  expect(pointer).toBeDefined()
  const frozen = await journal.object<{ digest: string; maxInputTokens: number }>(pointer!.ref)
  expect(frozen.maxInputTokens).toBe(70)
})
