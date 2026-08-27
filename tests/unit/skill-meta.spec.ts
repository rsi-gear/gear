import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillMetaCoordinator, SkillMetaSessionManager, type SkillHarnessIdentity } from '../../src/meta/skill.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { MetaAgentSpec } from '../../src/types.js'
import { evidence, roundFixture, SHA } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function identity(): SkillHarnessIdentity {
  return {
    runtime: { type: 'codex', version: '1.2.3', integrity: SHA('1') },
    preset: { id: 'refine', digest: SHA('2') },
    model: { provider: 'openai', model: 'gpt-test' },
    sampling: {},
  }
}

function spec(): MetaAgentSpec {
  const value = identity()
  return {
    runtime: value.runtime,
    preset: { ...value.preset, resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: value.preset.digest }] },
    model: value.model,
    sampling: {},
  }
}

describe('SkillMetaSessionManager', () => {
  it('leases one candidate to an exactly matching external harness and records attributable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-skill-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const coordinator = new SkillMetaCoordinator()
    const manager = new SkillMetaSessionManager(store, coordinator, {
      evolutionId: 'evo-1', specDigest: SHA('9'), metaAgent: spec(),
    })
    const parent = await manager.agent()
    const child = await manager.fork(await manager.checkpoint(parent.id))
    const round = roundFixture({
      status: 'candidate-editing',
      parentAllocations: [{
        candidateId: 'round-1-candidate-1', parentCandidateId: `initial-${'a'.repeat(40)}`,
        parentHarnessRef: 'a'.repeat(40), parentHarnessDigest: SHA('b'),
      }],
      candidatePool: [{
        candidateId: 'round-1-candidate-1', roundId: 'round-1', parentHarnessRef: 'a'.repeat(40),
        parentCandidateIds: [`initial-${'a'.repeat(40)}`], workspaceId: 'workspace-1', status: 'generating',
      }],
    })
    const baseline = evidence(round.plan.seed, round.targetHarnessRef, 0, '3')
    await manager.wakeCandidate(round, round.candidatePool[0], baseline, child)

    expect(() => coordinator.claim('codex-session', {
      ...identity(), model: { provider: 'openai', model: 'different' },
    }, round.evolutionId)).toThrow(/identity/)
    const claim = coordinator.claim('codex-session', identity(), round.evolutionId)
    expect(claim).toMatchObject({
      evolutionId: round.evolutionId,
      roundId: round.roundId,
      candidateId: round.candidatePool[0]?.candidateId,
      sessionId: child.id,
      workspaceId: 'workspace-1',
    })
    if (claim === undefined) throw new Error('assignment was not claimed')
    expect(coordinator.claim('another-client', identity(), round.evolutionId)).toBeUndefined()
    expect(coordinator.authorize(claim.leaseId, claim.leaseToken, 'codex-session').sessionId).toBe(child.id)
    expect(() => coordinator.authorize(claim.leaseId, 'wrong', 'codex-session')).toThrow(/lease/)

    const runId = baseline.trials[0]!.runId!
    manager.recordEvidenceAccess(round.roundId, child.id, { refs: [runId], diagnosedRunRefs: [runId] })
    expect(manager.proposalEvidenceAudit(round.roundId, child.id, [baseline.evalId])).toMatchObject({
      baselineEvalId: baseline.evalId,
      summaryAccessed: true,
      diagnosedRunRefs: [runId],
      citedRefs: [baseline.evalId],
    })
    expect(manager.proposalAttribution(round.roundId, child.id, {})).toMatchObject({
      evolutionId: round.evolutionId,
      sessionId: child.id,
      source: { kind: 'skill-lease', harness: 'codex', clientId: 'codex-session', leaseId: claim.leaseId },
      provider: 'openai',
      model: 'gpt-test',
    })

    await manager.release(child.id)
    expect(() => coordinator.authorize(claim.leaseId, claim.leaseToken, 'codex-session')).toThrow(/stale/)
    await manager.dispose()
  })
})
