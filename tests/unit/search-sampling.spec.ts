import { describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { clusters, deliveredWorkplan } from '../../src/search/diagnosis.js'
import { samplingEvidence, representativeOrder, crossOrder } from '../../src/search/scope-sampling.js'
import { createScope } from '../../src/search/scopes.js'
import { resolveSizing, seal, sorted } from '../../src/search/contracts.js'
import { evaluatedFixture, revise, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'

describe('scope representatives from frozen seed evidence', () => {
  it('covers diagnosed submodes and modules while reserving a successful counterexample within the ratio', () => {
    const base = universe(6), u = revise(base, { tasks: base.tasks.map((t, i) => ({ ...t, stratum: 'family', estimatedCost: i === 3 ? 100 : 1 })) })
    const parent = snapshot('parent'), baseline = evaluatedFixture(u, scopeFixture(u, u.tasks.map(t => t.id)), parent, id => ({ outcome: id === 'task-4' ? 1 : 0 })).result
    const facts = u.tasks.map((task, i) => ({ taskId: task.id, evidenceRefs: [baseline.cells[i]!.evidenceRef],
      status: i === 4 ? 'successful-control' as const : 'supported-hypothesis' as const, familyId: 'family', hypothesis: 'Correct verification', mechanism: 'Frozen feedback',
      submode: i === 2 ? 'missing-assertion' : 'missing-check', modificationPaths: [i === 3 ? 'parser' : 'workflow'] }))
    const dossier = seal({ parentSnapshotDigest: parent.digest, universeDigest: u.digest, taskIds: u.tasks.map(t => t.id), baselineEvidenceDigests: [baseline.digest], facts,
      classifierIntegrity: digestJson('classifier'), sanitizationPolicyDigest: digestJson('sanitizer') })
    const family = clusters(dossier, u, [])[0]!, config = settings().search
    config.taskSetSizing.local.ratio = 0.66; config.taskSetSizing.shared.ratio = 0; config.taskSetSizing.cross.ratio = 0
    const evidence = samplingEvidence(u, dossier.digest, [family], [baseline]), resolution = resolveSizing(u, config.taskSetSizing)
    const scope = createScope(u, resolution, config, family, [], 1, evidence)!
    expect(scope.buckets.local).toHaveLength(4)
    expect(scope.buckets.local).toEqual(expect.arrayContaining(['task-2', 'task-3', 'task-4']))
    expect(scope.sampling.local.reasons).toContain('successful-control-included')
    expect(scope.samplingEvidenceDigest).toBe(evidence.digest)
    expect(createScope(u, resolution, config, family, [], 1, evidence)).toEqual(scope)
    const workplan = seal({ candidateId: 'child', batchId: 'batch', parentSnapshotDigest: parent.digest, dossierDigest: dossier.digest,
      clusterDigest: family.digest, familyId: family.familyId, hypothesis: family.hypotheses[0]!, targetTaskIds: family.taskIds, requiredDiagnosisRefs: family.evidenceRefs,
      modificationPaths: family.modificationPaths, scopeDigest: scope.digest, localStagePlanDigest: digestJson('local-plan'),
      modificationBoundaryRule: { requiredSeedTaskIds: u.tasks.map(t => t.id), onInsufficientScope: 'retain-research-only' as const },
      generationBudget: { maxTokens: 100, maxModelRequests: 1, deadlineAt: 1000 } })
    expect(deliveredWorkplan(workplan, dossier, [], scope).dossier.facts.find(f => f.taskId === 'task-4')?.status).toBe('successful-control')
  })

  it('deduplicates execution slots and ignores incomplete history when estimating difficulty', () => {
    const base = universe(4), u = revise(base, { repetitions: [{ index: 0, seed: 0 }, { index: 1, seed: 1 }] })
    const scope = scopeFixture(u, u.tasks.map(t => t.id))
    const a = evaluatedFixture(u, scope, snapshot('a'), id => id === 'task-3' ? undefined : { outcome: id === 'task-2' ? 0 : 1 }).result
    const b = evaluatedFixture(u, scope, snapshot('b'), (id, slot) => id === 'task-3' || id === 'task-0' && slot === 1 ? undefined : { outcome: id === 'task-0' ? 1 : 0 }).result
    const evidence = samplingEvidence(u, digestJson('history'), [], [a, a, b])
    expect(evidence.tasks['task-0']!.historicalDifficulty).toBe(0)
    expect(evidence.tasks['task-1']!.historicalDifficulty).toBe(0.5)
    expect(evidence.tasks['task-2']!.historicalDifficulty).toBe(1)
    expect(evidence.tasks['task-3']!.historicalDifficulty).toBeUndefined()
    const sameStratum = revise(u, { tasks: u.tasks.map(t => ({ ...t, stratum: 'one' })) })
    const order = representativeOrder(sameStratum, u.tasks.map(t => t.id), 'fixed', evidence)
    expect(sorted(order)).toEqual(u.tasks.map(t => t.id))
    expect(order).toEqual(representativeOrder(sameStratum, [...u.tasks.map(t => t.id)].reverse(), 'fixed', evidence))
  })

  it('allocates cross checks uniformly across families, prefers shared modules and labels general fallback', () => {
    const base = universe(6), u = revise(base, { tasks: base.tasks.map((t, i) => ({ ...t, stratum: i < 2 ? 'B' : i < 4 ? 'C' : 'A' })) })
    const evidence = samplingEvidence(u, digestJson('history'), [], [])
    for (const i of [1, 3]) evidence.tasks[`task-${i}`]!.modificationPaths = ['shared/parser']
    const frozen = revise(evidence, { tasks: evidence.tasks })
    const cross = crossOrder(u, new Set(), 'A', ['shared'], 'fixed', frozen)
    expect(sorted(cross.ids.slice(0, 2))).toEqual(['task-1', 'task-3'])
    expect(cross.generalIds).toEqual(expect.arrayContaining(['task-4', 'task-5']))
    const only = revise(u, { tasks: u.tasks.map(t => ({ ...t, stratum: 'A' })) }), config = settings().search
    config.taskSetSizing.local.ratio = 0.16; config.taskSetSizing.shared.ratio = 0; config.taskSetSizing.cross.ratio = 0.2
    const scope = createScope(only, resolveSizing(only, config.taskSetSizing), config, { familyId: 'A', taskIds: ['task-0'] }, [])!
    expect(scope.sampling.cross.reasons).toContain('general-seed-sampling-fallback')
    expect(new Set(scope.taskIds).size).toBe(scope.taskIds.length)
  })
})
