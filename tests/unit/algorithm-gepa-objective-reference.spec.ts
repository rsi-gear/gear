import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaObjectiveReferenceProvider, type GepaObjectiveReferenceInput } from '../../src/algorithm/providers/gepa-objective-reference.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'
import { seal, validateSnapshot } from '../../src/search/contracts.js'
import { MemorySearchStore, evaluatedFixture, fixtures, revise, scopeFixture, settings } from '../../src/search/testing.js'
import type { Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gepa-objective-reference-'))
  roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const journal = new MemorySearchStore()
  const provider = () => new GepaObjectiveReferenceProvider(join(root, 'provider'), artifacts, journal)
  const snapshot = fixtures(2).anchor
  validateSnapshot(snapshot)
  const bindingSetRef = { kind: 'binding-set' as const, digest: jsonDigest('binding'), schemaId: 'fixture-binding' }
  const envelope = (input: GepaObjectiveReferenceInput): OperationEnvelope => {
    const operationId = jsonDigest(['objective-reference', input])
    return { campaignId: 'campaign-r', decisionIndex: 0, localKey: `objective-${input.mode}`,
      kind: 'gepa.objective-reference', operationId, idempotencyKey: operationId,
      input: input as unknown as JsonValue, inputDigest: jsonDigest(input as unknown as JsonValue),
      implementationDigest: provider().describe().implementationDigest, bindingSetRef, limits: {} }
  }
  const anchorInput: GepaObjectiveReferenceInput = { roundId: 'r', mode: 'anchor',
    snapshotRef: artifacts.putJson(snapshot as unknown as JsonValue, 'gepa.objective-initial-snapshot.v1') }
  return { artifacts, journal, provider, snapshot, envelope, anchorInput }
}

function baselineFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const contracts = ['quality', 'retained'].map(id => resolveMetric({ id, revision: '1', unit: 'score',
    direction: 'maximize', source: { path: `originalResult.${id}`, extractor: 'number-v1' },
    granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
  const universe: TaskUniverse = revise(fixtures(2).seed, { rawMetricContracts: contracts,
    objective: resolveObjective({ terms: [{ metric: 'quality', weight: 1 }],
      constraints: [{ metric: 'retained', rule: 'no_regression', reference: 'initial_baseline' }] }, contracts) })
  const scope = scopeFixture(universe, ['task-0'])
  const row = evaluatedFixture(universe, scope, f.snapshot, () => ({ outcome: 1 }), { stage: 'bridge' })
  const plan: StageEvaluationPlan = row.plan
  const { digest: ignored, ...body } = plan
  const referencePlan: StageEvaluationPlan = seal({ ...body, participantIds: [f.snapshot.candidateId],
    prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('objective-initial-reference-v1') })
  const cells = row.result.cells.map(cell => revise(cell, { rawMetrics: extractRawMetrics({ contracts,
    trial: { originalResult: { quality: 1, retained: 0.6 } }, certified: true,
    identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition, runId: cell.evidenceRef,
      attempt: 1, harnessCommit: cell.identity.harnessCommit, conditionDigest: cell.identity.conditionDigest,
      originalArtifactRefs: [digestJson(['raw-source', cell.identity])] } }) }))
  const result: StageResult = revise(row.result, { stagePlanDigest: referencePlan.digest, cells })
  const input: GepaObjectiveReferenceInput = { roundId: 'r', mode: 'baseline', universe, plan, referencePlan,
    resultRef: f.artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1') }
  return { input, result, plan, universe }
}

describe('GEPA objective reference provider', () => {
  it('freezes the first harness before any reference evaluation and blocks a changed anchor', async () => {
    const f = await fixture()
    expect((await f.provider().submit(f.envelope(f.anchorInput))).status).toBe('completed')
    expect((await f.journal.read<{ ref: string }>('evolution/objective-initial-harness'))?.ref)
      .toBe(f.snapshot.digest)
    expect((await f.provider().inspect(f.envelope(f.anchorInput))).status).toBe('completed')
    const changed: Snapshot = revise(f.snapshot, { candidateId: 'different-anchor' })
    const input: GepaObjectiveReferenceInput = { roundId: 'r', mode: 'anchor',
      snapshotRef: f.artifacts.putJson(changed as unknown as JsonValue, 'gepa.objective-initial-snapshot.v1') }
    await expect(f.provider().submit(f.envelope(input))).rejects.toMatchObject({ name: 'ProviderReconcileError' })
    expect((await f.journal.read<{ ref: string }>('evolution/objective-initial-harness'))?.ref)
      .toBe(f.snapshot.digest)
  })

  it('replays a lost baseline pointer acknowledgement without re-evaluating evidence', async () => {
    const f = await fixture()
    await f.provider().submit(f.envelope(f.anchorInput))
    const { input, result, plan, universe } = baselineFixture(f)
    const frozen = f.journal.freezeEvolution.bind(f.journal)
    let lost = false
    f.journal.freezeEvolution = async (...args) => {
      const value = await frozen(...args)
      if (args[0].startsWith('objective-initial-') && !lost) {
        lost = true
        throw new Error('lost objective reference acknowledgement')
      }
      return value
    }
    const envelope = f.envelope(input)
    await expect(f.provider().submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError' })
    expect((await f.provider().inspect(envelope)).status).toBe('replay-safe')
    const completion = await f.provider().submit(envelope)
    expect(completion.status).toBe('completed')
    const name = `objective-initial-${digestJson([universe.digest, plan.taskIds]).slice(7)}`
    const pointer = await f.journal.read<{ ref: string }>(`evolution/${name}`)
    expect(pointer?.ref).toMatch(/^sha256:/u)
    expect(await f.journal.object(pointer!.ref)).toMatchObject({ resultDigest: result.digest,
      initialSnapshotDigest: f.snapshot.digest })
  })

  it('persists cancellation before submit and never installs an initial harness', async () => {
    const f = await fixture()
    const envelope = f.envelope(f.anchorInput)
    expect(await f.provider().cancel(envelope)).toEqual({ status: 'cancelled', releaseConfirmed: true })
    await expect(f.provider().submit(envelope)).rejects.toThrow('Cancelled GEPA objective reference')
    expect(await f.journal.read('evolution/objective-initial-harness')).toBeUndefined()
  })

  it('reuses prior round reference baselines before any physical reference evaluation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons: Array<{ outcomes: unknown[]; referenceCalls: unknown[]; executions: unknown[] }> = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const journal = new MemorySearchStore(), f = fixtures(20), config = settings()
      const contracts = ['quality', 'retained'].map(id => resolveMetric({ id, revision: '1', unit: 'score',
        direction: 'maximize', source: { path: `originalResult.${id}`, extractor: 'number-v1' },
        granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
      const objective = resolveObjective({ terms: [{ metric: 'quality', weight: 1 }],
        constraints: [{ metric: 'retained', rule: 'no_regression', reference: 'initial_baseline' }] }, contracts)
      const seed = revise(f.seed, { rawMetricContracts: contracts, objective })
      const heldOut = revise(f.heldOut, { rawMetricContracts: contracts, objective })
      f.provider.capabilities.objectives = 1
      f.provider.describe = async partition => partition === 'seed' ? seed : heldOut
      const evaluate = f.provider.evaluate
      const referenceCalls: Array<{ round: string; stage: string; key: string }> = []
      let round = 'r1'
      f.provider.evaluate = async input => {
        if (input.plan.selectionRuleDigest === digestJson('objective-initial-reference-v1'))
          referenceCalls.push({ round, stage: input.plan.stage, key: input.idempotencyKey })
        return (await evaluate(input)).map(cell => revise(cell, { rawMetrics: extractRawMetrics({ contracts,
          certified: true, trial: { originalResult: { quality: cell.outcome.status === 'available'
            ? cell.outcome.rawValue : 0, retained: input.snapshot.candidateId === f.anchor.candidateId ? 0.6 : 0.7 } },
          identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition, runId: cell.evidenceRef,
            attempt: 1, harnessCommit: cell.identity.harnessCommit, conditionDigest: cell.identity.conditionDigest,
            originalArtifactRefs: [digestJson(['source', cell.identity])] } }) }))
      }
      const first = await new Search(journal, f.provider, f.diagnosis, f.hooks).run({
        evolutionId: 'objective-two-rounds', roundId: 'r1', roundIndex: 0, maxCandidates: 1,
        anchor: f.anchor, championRevisionDigest: digestJson('objective-two-rounds-champion'), settings: config,
      }, new AbortController().signal)
      const archive = await journal.archive()
      const secondAnchor = first.championChanged
        ? archive!.snapshots.find(snapshot => snapshot.candidateId === first.nomineeId)! : f.anchor
      round = 'r2'
      const second = await new Search(journal, f.provider, f.diagnosis, f.hooks).run({
        evolutionId: 'objective-two-rounds', roundId: 'r2', roundIndex: 1, maxCandidates: 1,
        anchor: secondAnchor, championRevisionDigest: digestJson('objective-two-rounds-champion-2'), settings: config,
      }, new AbortController().signal)
      comparisons.push({ outcomes: [first, second], referenceCalls, executions: f.executions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
    expect(comparisons[0]!.referenceCalls.some(call => (call as { round: string }).round === 'r1')).toBe(true)
    expect(comparisons[0]!.referenceCalls.some(call => (call as { round: string }).round === 'r2')).toBe(false)
  })
})
