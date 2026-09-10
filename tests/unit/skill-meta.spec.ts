import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSkillHarnessIdentityMatches,
  parseSkillHarnessIdentity,
  skillHarnessIdentity,
  SkillMetaCoordinator,
  SkillMetaSessionManager,
  type SkillHarnessIdentity,
} from '../../src/meta/skill.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { MetaAgentSpec } from '../../src/types.js'
import { compatibleSkillMetaAgent } from '../../src/meta/controller.js'
import { RefineSkillGateway } from '../../src/skill/gateway.js'
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

describe('Skill harness identity', () => {
  it('projects only the public fields and returns a detached canonical identity', () => {
    const source = {
      ...spec(),
      model: { provider: 'openai', model: 'gpt-test', maxTokens: 8192 },
      sampling: { temperature: 0.5, reasoningEffort: 'medium' },
      contextOffloading: { ignored: true },
    } as unknown as MetaAgentSpec
    const projected = skillHarnessIdentity(source)
    expect(projected).toEqual({
      runtime: identity().runtime,
      preset: identity().preset,
      model: { provider: 'openai', model: 'gpt-test', maxTokens: 8192 },
      sampling: { temperature: 0.5, reasoningEffort: 'medium' },
    })
    expect(projected).not.toBe(source)
    expect(projected.runtime).not.toBe(source.runtime)
  })

  it.each([
    [{ ...identity(), contextOffloading: {} }, 'identity.contextOffloading'],
    [{ ...identity(), runtime: { ...identity().runtime, extra: true } }, 'identity.runtime.extra'],
    [{ ...identity(), preset: { ...identity().preset, resources: [] } }, 'identity.preset.resources'],
    [{ ...identity(), model: { ...identity().model, maxTokens: 0 } }, 'identity.model.maxTokens'],
    [{ ...identity(), sampling: { unknown: true } }, 'identity.sampling.unknown'],
    [{ ...identity(), sampling: { temperature: 3 } }, 'identity.sampling.temperature'],
    [{ ...identity(), sampling: { reasoningEffort: ' medium' } }, 'identity.sampling.reasoningEffort'],
    [{ ...identity(), runtime: { ...identity().runtime, integrity: 'not-a-digest' } }, 'identity.runtime.integrity'],
    [{ ...identity(), preset: { ...identity().preset, digest: SHA('A') } }, 'identity.preset.digest'],
    [{ runtime: identity().runtime, preset: identity().preset, model: identity().model }, 'identity.sampling'],
  ])('strictly rejects an invalid public identity at %s', (value, path) => {
    expect(() => parseSkillHarnessIdentity(value)).toThrow(path as string)
  })

  it('reports the first mismatched canonical field without printing either identity', () => {
    expect(() => assertSkillHarnessIdentityMatches(
      { ...identity(), model: { ...identity().model, model: 'other' } },
      identity(),
      'configured identity mismatch',
    )).toThrow('configured identity mismatch at identity.model.model')
  })

  it('serves current and sealed projections without creating a coordinator lease', async () => {
    const current = spec()
    const sealed = { ...spec(), model: { ...spec().model, maxTokens: 4096 } }
    const coordinator = new SkillMetaCoordinator()
    const gateway = new RefineSkillGateway({
      options: { metaAgent: current },
      registry: {
        async requireSpec(evolutionId: string) {
          if (evolutionId !== 'sealed') throw new Error(`unknown evolution: ${evolutionId}`)
          return { metaAgent: sealed }
        },
      },
    } as never, coordinator, {} as never, {} as never)

    await expect(gateway.call('control.identity', {})).resolves.toEqual(skillHarnessIdentity(current))
    await expect(gateway.call('control.identity', { evolutionId: 'sealed' })).resolves.toEqual(skillHarnessIdentity(sealed))
    await expect(gateway.call('control.identity', { evolutionId: 'missing' })).rejects.toThrow('unknown evolution: missing')
    await expect(gateway.call('meta.claim', {
      clientId: 'codex-client',
      identity: { ...identity(), preset: { ...identity().preset, resources: [] } },
    })).rejects.toThrow('identity.preset.resources')
    expect(coordinator.pending()).toEqual([])
  })
})

describe('SkillMetaSessionManager', () => {
  it('requires the same sealed reasoning effort when resuming an external Meta harness', () => {
    const medium = { ...spec(), sampling: { reasoningEffort: 'medium' } }
    expect(compatibleSkillMetaAgent(medium, structuredClone(medium))).toBe(true)
    expect(compatibleSkillMetaAgent(medium, { ...medium, sampling: { reasoningEffort: 'low' } })).toBe(false)
    expect(compatibleSkillMetaAgent(medium, spec())).toBe(false)
    expect(compatibleSkillMetaAgent(spec(), spec())).toBe(true)
  })

  it('leases one candidate to an exactly matching external harness and records attributable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-skill-meta-'))
    roots.push(root)
    const store = new RefineStateStore(root)
    await store.initialize()
    const coordinator = new SkillMetaCoordinator()
    const manager = new SkillMetaSessionManager(store, coordinator, {
      evolutionId: 'evo-1', specDigest: SHA('9'), metaAgent: { ...spec(), sampling: { reasoningEffort: 'medium' } },
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
    expect(() => coordinator.claim('codex-session', identity(), round.evolutionId)).toThrow(/immutable evolution spec/)
    const mediumIdentity = { ...identity(), sampling: { reasoningEffort: 'medium' } }
    const claim = coordinator.claim('codex-session', mediumIdentity, round.evolutionId)
    expect(claim).toMatchObject({
      evolutionId: round.evolutionId,
      roundId: round.roundId,
      candidateId: round.candidatePool[0]?.candidateId,
      sessionId: child.id,
      workspaceId: 'workspace-1',
    })
    if (claim === undefined) throw new Error('assignment was not claimed')
    expect(coordinator.claim('another-client', mediumIdentity, round.evolutionId)).toBeUndefined()
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
      sampling: { reasoningEffort: 'medium' },
    })

    await manager.release(child.id)
    expect(() => coordinator.authorize(claim.leaseId, claim.leaseToken, 'codex-session')).toThrow(/stale/)
    await manager.dispose()
  })
})
