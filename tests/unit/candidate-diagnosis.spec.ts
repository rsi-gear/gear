import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { SkillMetaCoordinator, SkillMetaSessionManager, skillHarnessIdentity } from '../../src/meta/skill.js'
import { CandidateDiagnosisStore, type CandidateDiagnosisRecord, type CandidateDiagnosisScope } from '../../src/state/candidate-diagnosis.js'
import { RefineStateStore } from '../../src/state/store.js'
import { digestJson } from '../../src/state/digest.js'
import { generationBudgetSnapshot } from '../../src/refine/generation-budget.js'
import type { CandidateGenerationBudgetStatus, HitchTrajectoryReader } from '../../src/types.js'
import { evidence, evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js'
import { trajectoryAnalysis } from '../helpers/trajectory-fixture.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(details = '', messages: { prompt?: string; assistant?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-diagnosis-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new RefineStateStore(root)
  await store.initialize()
  const spec = evolutionSpec()
  const round = roundFixture()
  const baseline = evidence(round.plan.seed, round.targetHarnessRef, 0)
  const candidate = { ...round.candidatePool[0]!, workspaceId: 'workspace-1' }
  round.candidatePool = [candidate]
  round.parentAllocations = [{ candidateId: candidate.candidateId, parentCandidateId: candidate.parentCandidateIds[0]!,
    parentHarnessRef: candidate.parentHarnessRef, parentHarnessDigest: round.targetHarnessDigest }]
  const scope: CandidateDiagnosisScope = { evolutionId: spec.evolutionId, specDigest: digestJson(spec),
    roundId: round.roundId, candidateId: candidate.candidateId, parentHarnessDigest: round.targetHarnessDigest,
    baselineDigest: digestJson(baseline) }
  const coordinator = new SkillMetaCoordinator()
  const meta = new SkillMetaSessionManager(store, coordinator, {
    evolutionId: spec.evolutionId, specDigest: digestJson(spec), metaAgent: spec.metaAgent,
  })
  cleanup.push(() => meta.dispose())
  const parent = await meta.checkpoint()
  let session = await meta.fork(parent)
  let attempt = 1
  let controller = new AbortController()
  let budget: CandidateGenerationBudgetStatus | undefined
  const claim = async () => {
    await meta.wakeCandidate(round, candidate, baseline, session)
    coordinator.claim('client', skillHarnessIdentity(spec.metaAgent))
  }
  await claim()
  const journal = () => new CandidateDiagnosisStore(root, scope)
  const service = {
    activeEntryForSession: (id: string) => id !== session.id || controller.signal.aborted ? undefined : ({
      evolutionId: spec.evolutionId, spec, roundId: round.roundId, candidateId: candidate.candidateId,
      store, meta, baseline, workspace: { workspaceId: candidate.workspaceId }, signal: controller.signal,
      parentHarnessRef: candidate.parentHarnessRef, parentHarnessDigest: scope.parentHarnessDigest,
      ...(budget === undefined ? {} : { generationBudget: generationBudgetSnapshot(budget) }),
    }),
    readCandidateDiagnoses: async () => journal().read(),
    recordCandidateDiagnosis: async (id: string, record: Omit<CandidateDiagnosisRecord, 'source'>) => {
      await journal().write({ ...record, source: { sessionId: id, attempt } }, () => {
        if (service.activeEntryForSession(id) === undefined) throw new Error('stale owner')
      })
    },
  }
  let trajectoryText = messages.assistant ?? 'original observed trajectory'
  let verifierText = details
  let secrets = ['sensitive-value']
  const reader: HitchTrajectoryReader = {
    async inspectCapabilities() { return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 } },
    async inspectTrajectoryAnalysis(runId) {
      return trajectoryAnalysis(runId, [
        { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: messages.prompt ?? 'Diagnose the task' }] } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: trajectoryText }] } } },
      ])
    },
    async inspectTrajectoryEvents() { throw new Error('unexpected trajectory detail fetch') },
    async inspectVerifierEvidence(runId) { return { runId, verifier: verifierText === '' ? { status: 'result_only' }
      : { status: 'complete', diagnostics: { stdout: [{ name: 'failure.txt', text: verifierText }] } } } },
  }
  const capabilities = () => new RefineCapabilities(service as never, {} as never, { trajectoryReader: reader, secretValues: secrets })
  let caps = capabilities()
  return {
    scope, baseline, journal,
    setBudget: (value: CandidateGenerationBudgetStatus) => { budget = value },
    call: (args: unknown) => caps.call('refine-meta', session.id, 'trajectory.query', args) as Promise<any>,
    mutate: (kind: string) => {
      if (kind === 'trajectory') trajectoryText = 'changed trajectory'
      else if (kind === 'verifier') verifierText = 'changed verifier evidence'
      else if (kind === 'policy') secrets = ['another-policy']
      else if (kind === 'baseline') { baseline.trials[0]!.attempt = 2; scope.baselineDigest = digestJson(baseline) }
      else if (kind === 'parent') scope.parentHarnessDigest = SHA('f')
      else if (kind === 'sibling') scope.candidateId = 'sibling-2'
      else if (kind === 'round') scope.roundId = 'round-2'
      else if (kind === 'evolution') scope.evolutionId = 'evo-2'
    },
    retry: async () => {
      controller.abort()
      await meta.cancel(session.id, 'attempt expired')
      await meta.release(session.id)
      controller = new AbortController()
      session = await meta.fork(parent)
      attempt += 1
      await claim()
      caps = capabilities()
    },
  }
}

describe('durable candidate diagnosis recovery', () => {
  it.each(['inline', 'paginated'])('retains the sanitized task prompt after a long reply with %s verifier evidence', async mode => {
    const f = await fixture(mode === 'paginated' ? 'failure details '.repeat(3000) : '', {
      prompt: 'Diagnose the task using sensitive-value',
      assistant: 'Long assistant reply. '.repeat(100),
    })
    const first = await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    let ref = first.runs[0].verifier.detailRef
    if (mode === 'paginated') expect(ref).toBeDefined()
    while (ref !== undefined) ref = (await f.call({ detailRef: ref })).nextRef
    await f.retry()
    const recovered = await f.call({})
    expect(recovered.diagnosisProgress).toMatchObject({ diagnosed: 1, required: 1 })
    const restored = recovered.diagnosisRecovery.restored[0]
    expect(restored.transcriptTail).not.toContain('Diagnose the task')
    expect(restored.prompt).toBe('Diagnose the task using [REDACTED]')
    const saved = await f.journal().read()
    expect(saved[0]!.evidence.card.prompt?.text).toBe(restored.prompt)
    expect(JSON.stringify(saved)).not.toContain('sensitive-value')
  })

  it('warns when diagnosis consumes the reserve without inventing an ETA or blocking reads', async () => {
    const f = await fixture()
    f.setBudget({ attempt: 1, maxAttemptsPerCandidate: 2, attemptTimeoutMs: 10_000, roundTimeoutMs: 20_000,
      deadlineAt: Date.now() + 5000, roundDeadlineAt: Date.now() + 20_000,
      remainingMs: 0, roundRemainingMs: 0, finalizationReserveMs: 6000, diagnosisAvailableMs: 0 })
    expect(await f.call({})).toMatchObject({ generationBudget: {
      diagnosisAvailableMs: 0, estimatedDiagnosisRemainingMs: null, warning: 'DIAGNOSIS_BUDGET_AT_RISK',
    } })
    const completed = await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    expect(completed.generationBudget).toMatchObject({ diagnosedRunCount: 1, estimatedDiagnosisRemainingMs: 0 })
    expect(completed.generationBudget).not.toHaveProperty('warning')
  })

  it.each(['trajectory', 'verifier', 'policy', 'baseline', 'parent', 'sibling', 'round', 'evolution'])(
    'does not reuse progress after a change to %s', async kind => {
      const f = await fixture()
      await f.call({ refs: [f.baseline.trials[0]!.runId!] })
      expect(await f.journal().read()).toHaveLength(1)
      f.mutate(kind)
      await f.retry()
      expect(await f.call({})).toMatchObject({ diagnosisProgress: { diagnosed: 0, required: 1 } })
    },
  )

  it('requires complete verifier pagination, then restores sanitized evidence with a new session ref', async () => {
    const f = await fixture(`sensitive-value ${'failure details '.repeat(3000)}`)
    const first = await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    const oldRef = first.runs[0].verifier.detailRef as string
    expect(oldRef).toBeDefined()
    expect(await f.journal().read()).toHaveLength(0)
    const page = await f.call({ detailRef: oldRef })
    expect(page.nextRef).toBeDefined()
    expect(await f.journal().read()).toHaveLength(0)
    // Incomplete reads cannot turn into credit at an attempt boundary.
    await f.retry()
    expect(await f.call({})).toMatchObject({ diagnosisProgress: { diagnosed: 0 } })
    await expect(f.call({ detailRef: oldRef })).rejects.toThrow(/no longer valid/)
    const second = await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    let ref = second.runs[0].verifier.detailRef
    while (ref !== undefined) ref = (await f.call({ detailRef: ref })).nextRef
    const saved = await f.journal().read()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.evidence.verifierDetails).toContain('[REDACTED]')
    expect(JSON.stringify(saved)).not.toContain('sensitive-value')
    expect(JSON.stringify(saved[0]!.evidence)).not.toMatch(/detail_[a-f0-9]+/u)
    await f.retry()
    const recovered = await f.call({})
    expect(recovered).toMatchObject({ diagnosisProgress: { diagnosed: 1, required: 1 } })
    const newRef = recovered.diagnosisRecovery.restored[0].detailRef
    expect(newRef).not.toBe(oldRef)
    expect(JSON.stringify(await f.call({ detailRef: newRef }))).toContain('[REDACTED]')
  })

  it('retains completed evidence if the client loses the response, and recovers it from disk', async () => {
    const f = await fixture()
    await f.call({ refs: [f.baseline.trials[0]!.runId!] }) // Deliberately discard the response.
    await f.retry()
    const recovered = await f.call({})
    expect(recovered).toMatchObject({ diagnosisProgress: { diagnosed: 1 }, diagnosisRecovery: { remaining: 0 } })
    expect(JSON.stringify(recovered)).toContain('original observed trajectory')
    expect(await f.call({})).not.toHaveProperty('diagnosisRecovery')
  })

  it.each([1, 2, 3])('does not publish a write whose owner expires at check %s', async expiration => {
    const f = await fixture()
    await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    const record = (await f.journal().read())[0]!
    f.scope.candidateId = 'new-candidate'
    let checks = 0
    await expect(f.journal().write(record, () => {
      if (++checks === expiration) throw new Error('expired owner')
    })).rejects.toThrow('expired owner')
    expect(await f.journal().read()).toEqual([])
  })

  it('deduplicates the same completed read and rejects corrupted records', async () => {
    const f = await fixture()
    await f.call({ refs: [f.baseline.trials[0]!.runId!] })
    const record = (await f.journal().read())[0]!
    await Promise.all([f.journal().write(record, () => {}), f.journal().write(record, () => {})])
    expect(await f.journal().read()).toHaveLength(1)
    // A separate fixture root is unnecessary: the record directory is a scope digest.
    const directory = (f.journal() as unknown as { directory: string }).directory
    const path = join(directory, (await readdir(directory)).find(value => value.endsWith('.json'))!)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.record.evidence.card.task = 'tampered'
    await writeFile(path, JSON.stringify(saved))
    await expect(f.journal().read()).rejects.toThrow(/integrity/)
  })
})

describe('generation budget snapshots', () => {
  it('caps an attempt by the unchanged round deadline and reserves time without extending either deadline', () => {
    const budget = { attempt: 2, maxAttemptsPerCandidate: 2, attemptTimeoutMs: 1800, roundTimeoutMs: 3600,
      deadlineAt: 5000, roundDeadlineAt: 4500, remainingMs: 0, roundRemainingMs: 0,
      finalizationReserveMs: 300, diagnosisAvailableMs: 0 }
    expect(generationBudgetSnapshot(budget, 4000)).toMatchObject({ remainingMs: 500, diagnosisAvailableMs: 200 })
    expect(generationBudgetSnapshot(budget, 4400)).toMatchObject({ remainingMs: 100, diagnosisAvailableMs: 0 })
    expect(generationBudgetSnapshot(budget, 4600)).toMatchObject({ remainingMs: 0, roundRemainingMs: 0,
      deadlineAt: 5000, roundDeadlineAt: 4500 })
  })
})
