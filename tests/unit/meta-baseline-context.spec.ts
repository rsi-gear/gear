import { describe, expect, it } from 'vitest'
import { ProjectExperience } from '../../src/application/experience.js'
import type { ExperienceContext, ExperienceSnapshot } from '../../src/domain/experience.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const implementation = canonicalDigest('meta-baseline-test')

function setup() {
  const snapshot = {
    version: 3,
    run_id: 'run',
    source_archive_digest: canonicalDigest('archive'),
    implementation_identity: implementation,
    records: [],
    digest: canonicalDigest('snapshot'),
  } as ExperienceSnapshot
  const experience = new ProjectExperience('unused', {} as never)
  experience.store.read = async () => snapshot
  const evidence = [
    {
      candidate_id: 'anchor',
      task_id: 'seed-task',
      repetition: 0,
      score: 0,
      status: 'valid' as const,
      scope: 'global',
      feedback: 'failed baseline behavior',
    },
  ]
  const contextBody: Omit<ExperienceContext, 'digest'> = {
    version: 2,
    snapshot_digest: snapshot.digest,
    implementation_identity: implementation,
    available_records: 0,
    cards: [],
    baseline: {
      candidate_id: 'anchor',
      trajectory_refs: [],
      missing_trajectory_slots: [{ task_id: 'seed-task', repetition: 0, reason: 'not_captured' }],
    },
  }
  const context = { ...contextBody, digest: canonicalDigest(contextBody) }
  const request = {
    runId: 'run',
    operation: { kind: 'diagnose_seed', candidate_id: 'anchor', task_ids: ['seed-task'] },
    evidence,
    experience: context,
  } as unknown as OperationRequest
  return { experience, request, context }
}

describe('baseline trajectory context validation', () => {
  it('accepts the baseline trajectory scope reserved for the diagnosis', async () => {
    const { experience, request } = setup()
    await expect(experience.verify(request)).resolves.toBeUndefined()
  })

  it('rejects a trajectory reference outside the reserved baseline evidence', async () => {
    const { experience, request, context } = setup()
    const body = {
      ...context,
      baseline: {
        ...context.baseline!,
        trajectory_refs: [
          {
            ref: `trajectory:${'a'.repeat(64)}`,
            candidate_id: 'anchor',
            task_id: 'held-out-task',
            repetition: 0,
            status: 'unavailable' as const,
            content_digest: null,
            reason: 'missing',
          },
        ],
      },
    }
    const { digest: _digest, ...unsigned } = body
    const forged = { ...unsigned, digest: canonicalDigest(unsigned) }
    await expect(experience.verify({ ...request, experience: forged })).rejects.toMatchObject({
      code: 'experience-context-mismatch',
    })
  })

  it('rejects a missing-trajectory marker outside the reserved baseline evidence', async () => {
    const { experience, request, context } = setup()
    const body = {
      ...context,
      baseline: {
        ...context.baseline!,
        missing_trajectory_slots: [
          { task_id: 'held-out-task', repetition: 0, reason: 'not_captured' as const },
        ],
      },
    }
    const { digest: _digest, ...unsigned } = body
    const forged = { ...unsigned, digest: canonicalDigest(unsigned) }
    await expect(experience.verify({ ...request, experience: forged })).rejects.toMatchObject({
      code: 'experience-context-mismatch',
    })
  })
})
