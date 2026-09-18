import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { selectParents } from '../../src/search/archive.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { fixtures, revise, settings } from '../helpers/search-fixture.js'

it.each([true, false])('[A04,D02,R05,P01,E05] uses historical code/evidence parents independently of champion (repeated=%s)', async repeated => {
  const f = fixtures(20), config = settings(), root = await mkdtemp(join(tmpdir(), 'gear-history-'))
  config.search.parentBatchCount = 2
  const store = new SearchStore(root)
  const assignments = new Map<string, { family: string; parent: string }>()
  const deliveries: Parameters<typeof f.hooks.generate>[0][] = []
  const diagnoses: Parameters<typeof f.diagnosis.diagnose>[0][] = []
  const generate = f.hooks.generate, evaluate = f.provider.evaluate, diagnose = f.diagnosis.diagnose
  f.hooks.generate = async input => {
    deliveries.push(input)
    assignments.set(input.delivery.workplan.candidateId, { family: input.delivery.workplan.familyId, parent: input.parent.candidateId })
    return generate(input)
  }
  f.diagnosis.diagnose = async input => { diagnoses.push(input); return diagnose(input) }
  f.provider.evaluate = async input => {
    const cells = await evaluate(input), assignment = assignments.get(input.snapshot.candidateId)
    return cells.map(cell => {
      const family = `family-${Number(cell.identity.taskId.slice(5)) % 4}`
      const parent = assignment && assignments.get(assignment.parent)
      const score = !assignment ? 0.85 : !parent ? family === assignment.family ? 0.9 : 0.1
        : family === parent.family ? 1 : family === assignment.family ? 0.6 : 0.1
      return revise(cell, { outcome: { status: 'available', rawValue: score, contractDigest: cell.identity.outcomeContractDigest, evidenceRef: cell.evidenceRef } })
    })
  }
  const run = (roundId: string, roundIndex: number) => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run({ evolutionId: 'history', roundId, roundIndex, maxCandidates: 4,
    anchor: f.anchor, championRevisionDigest: digestJson('fixed-champion'), settings: config }, new AbortController().signal)
  try {
    const first = await run('r0', 0), archived = (await store.archive())!
    expect(first.championChanged).toBe(false)
    expect(first.research.workplans).toHaveLength(4)
    expect(first.research.candidates.every(c => c.profile.outcome! < 0.85)).toBe(true)
    expect(diagnoses).toHaveLength(1) // Repeated root draws reuse the same dossier.
    const specialist = archived.snapshots.find(s => s.candidateId === 'r0-candidate-1')!
    expect(archived.activeParentIds).toContain(specialist.candidateId)
    const other = repeated ? specialist : archived.snapshots.find(s => s.candidateId === 'r0-candidate-2')!
    const roundId = Array.from({ length: 512 }, (_, i) => `historical-${i}`).find(id =>
      selectParents(archived, config.search, 4, id).batches.every((b, index) => b.parentSnapshotDigest === (index === 0 ? specialist : other).digest))!
    expect(roundId).toBeDefined()
    const beforeGeneration = deliveries.length, second = await run(roundId, 1), next = (await store.archive())!
    expect(second.research.parents.batches).toHaveLength(2)
    expect(second.research.parents.batches.map(b => b.parentSnapshotDigest)).toEqual([specialist.digest, other.digest])
    expect(second.championAnchorDigest).toBe(f.anchor.digest)
    expect(second.championChanged).toBe(false)
    expect(second.research.workplans).toHaveLength(repeated ? 2 : 3) // Only confirmed witnesses create plans; repeated draws never duplicate them.
    expect(deliveries.slice(beforeGeneration)).toHaveLength(repeated ? 2 : 3)
    for (const delivery of deliveries.slice(beforeGeneration)) {
      const allocation = second.research.parents.batches.find(b => b.batchId === delivery.delivery.workplan.batchId)!
      expect(delivery.parent.digest).toBe(allocation.parentSnapshotDigest)
      expect(delivery.delivery.dossier.parentSnapshotDigest).toBe(delivery.parent.digest)
      expect(delivery.delivery.findings).toEqual([first.findings.find(f => f.candidateId === delivery.parent.candidateId)])
      const ownRefs = new Set(diagnoses.find(d => d.snapshot.digest === delivery.parent.digest)!.cells.map(c => c.evidenceRef))
      expect(delivery.delivery.dossier.facts.length).toBeGreaterThan(0)
      expect(delivery.delivery.dossier.facts.every(fact => fact.evidenceRefs.every(ref => ownRefs.has(ref)))).toBe(true)
    }
    if (!repeated) {
      expect(second.reasonCodes.some(code => code.startsWith('hypothesis-unconfirmed:'))).toBe(true)
      expect(new Set(deliveries.slice(beforeGeneration).map(d => d.parent.digest))).toEqual(new Set([specialist.digest, other.digest]))
    }
    const delivered = deliveries[beforeGeneration]!
    expect(delivered.parent).toEqual(specialist)
    expect(delivered.baseline.snapshotDigest).toBe(specialist.digest)
    expect(delivered.delivery.dossier.parentSnapshotDigest).toBe(specialist.digest)
    expect(delivered.delivery.findings).toEqual([first.findings.find(f => f.candidateId === specialist.candidateId)])
    expect(diagnoses.filter(d => d.snapshot.digest === specialist.digest)).toHaveLength(1)
    if (!repeated) expect(diagnoses.filter(d => d.snapshot.digest === other.digest)).toHaveLength(1)
    const diagnosticRefs = new Set(diagnoses.find(d => d.snapshot.digest === specialist.digest)!.cells.map(c => c.evidenceRef))
    expect(delivered.delivery.dossier.facts.every(fact => fact.evidenceRefs.every(ref => diagnosticRefs.has(ref)))).toBe(true)
    const child = next.snapshots.find(s => s.candidateId === delivered.delivery.workplan.candidateId)!
    expect(child.parentIds).toEqual([specialist.candidateId])
    expect(second.findings[0]!.improvements.length).toBeGreaterThan(0)
    expect(second.research.bridge.plan?.participantIds).toContain(f.anchor.candidateId)
    expect(second.research.bridge.plan?.participantIds).not.toContain(specialist.candidateId)
    expect(next.snapshots.find(s => s.candidateId === specialist.candidateId)).toEqual(specialist)
    expect(f.generated.filter(id => id === specialist.candidateId)).toHaveLength(1)
    expect(await store.object<typeof archived>(archived.digest)).toEqual(archived)
    expect(f.promotions).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
