import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaResearchCheckpointProvider } from '../../src/algorithm/providers/gepa-research-checkpoint.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { buildArchive } from '../../src/search/archive.js'
import { profile } from '../../src/search/evidence.js'
import { seal } from '../../src/search/contracts.js'
import { MemorySearchStore, evaluatedFixture, fixtures, scopeFixture, settings } from '../../src/search/testing.js'
import type { SearchProgress } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gepa-research-progress-')); roots.push(root)
  const f = fixtures(4), config = settings()
  const { scope, plan, result } = evaluatedFixture(f.seed, scopeFixture(f.seed, ['task-0']),
    f.anchor, () => ({ outcome: 1 }), { stage: 'baseline-probe' })
  const archive = buildArchive({ evolutionId: 'e', universe: f.seed, snapshots: [f.anchor],
    scopes: [scope], plans: [plan], results: [result], config: config.search,
    championId: f.anchor.candidateId })
  const measured = profile(f.seed, plan, f.anchor, result, config.search.process.mode)
  const row: SearchProgress['evaluations'][number] = { stage: plan.stage as 'baseline-probe',
    stagePlanDigest: plan.digest, scopeDigest: plan.scopeDigest, candidateId: f.anchor.candidateId,
    state: 'settled', plannedCells: 1, profile: {
      coverage: measured.coverage, processCoverage: measured.processCoverage,
      outcomeComplete: measured.outcomeComplete, processComplete: measured.processComplete,
      processTaskIds: measured.processTaskIds, tasks: measured.tasks, supportDigest: measured.supportDigest } }
  const { digest: ignored, ...planBody } = plan
  const referencePlan = seal({ ...planBody, selectionRuleDigest: digestJson('reference') })
  const referenceRow = { ...row, stagePlanDigest: referencePlan.digest }
  const frozen: SearchProgress = { phase: 'bootstrap', evaluations: [row], decisions: [] }
  const live: SearchProgress = { phase: 'bootstrap', evaluations: [referenceRow, row], decisions: [] }
  const journal = new MemorySearchStore(), artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const makeProvider = () => new GepaResearchCheckpointProvider(join(root, 'operations'), artifacts, journal)
  const provider = makeProvider()
  const input = { roundId: 'r', publishResearch: false, archiveRef: artifacts.putJson(archive as unknown as JsonValue,
    'gepa.research-archive.v1'), findings: [], progressRef: artifacts.putJson(frozen as unknown as JsonValue,
    'gepa.seed-progress.v1') } as unknown as JsonValue
  const operationId = digestJson(['research-progress', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'checkpoint',
    operationId, idempotencyKey: operationId, kind: 'gepa.research-checkpoint', input,
    inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
    bindingSetRef: { kind: 'binding-set', digest: jsonDigest('binding'), schemaId: 'fixture-binding' }, limits: {} }
  return { journal, provider, makeProvider, envelope, frozen, live, artifacts }
}

it('preserves the live objective-reference row when sealing seed progress, including a lost acknowledgement', async () => {
  const { journal, provider, makeProvider, envelope, live, artifacts } = setup()
  await journal.write('rounds/r/progress', live)
  const write = journal.write.bind(journal)
  let loseAck = true
  journal.write = async (name, value) => {
    await write(name, value)
    if (name === 'rounds/r/progress' && loseAck && (value as SearchProgress).phase === 'bootstrap') {
      loseAck = false
      throw new Error('progress acknowledgement lost')
    }
  }
  // Force publication to write its phase while retaining the live evaluation rows.
  await journal.write('rounds/r/progress', { ...live, phase: 'scope-preparation' })
  await expect(provider.submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError',
    cause: { message: 'progress acknowledgement lost' } })
  const resumed = makeProvider()
  expect((await resumed.inspect(envelope)).status).toBe('replay-safe')
  const completed = await resumed.submit(envelope)
  expect(completed.status).toBe('completed')
  expect(await journal.read('rounds/r/progress')).toEqual(live)
  if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result')
    throw new Error('missing research checkpoint')
  const value = completed.completion.outcome.value as unknown as { checkpointRef: Parameters<typeof artifacts.getJson>[0] }
  expect(artifacts.getJson(value.checkpointRef)).toMatchObject({ progressDigest: jsonDigest(live as unknown as JsonValue) })
  expect((await makeProvider().inspect(envelope)).status).toBe('completed')
})

it('rejects a live progress row that disagrees with the sealed seed evidence', async () => {
  const { journal, provider, envelope, live } = setup()
  await journal.write('rounds/r/progress', { ...live, evaluations: [live.evaluations[0]!,
    { ...live.evaluations[1]!, plannedCells: 2 }] })
  await expect(provider.submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError',
    cause: { message: 'GEPA seed evaluation progress differs from verified evidence' } })
})
