import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/config.js'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { NoopHarnessCompiler } from '../../src/harness/builder.js'
import type { SkillHarnessIdentity } from '../../src/meta/skill.js'
import { requestRefineSkill } from '../../src/skill/client.js'
import { createSkillControlPlane } from '../../src/skill/control-plane.js'
import type {
  EvaluationPhase,
  EvaluationRequest,
  EvaluationReservation,
  HitchEvaluationEvidence,
  HitchCapabilities,
  HitchTrajectoryAnalysis,
  HitchTrajectoryEventsPage,
  HitchTrajectoryEventsQuery,
  RefineEvaluator,
  RefinementRound,
} from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { documentedHarnessCandidate, documentedSkillCandidate } from '../helpers/documented-skill-candidate.js'
import { SHA } from '../helpers/research-fixture.js'
import { trajectoryAnalysis, trajectoryEventsPage } from '../helpers/trajectory-fixture.js'
import { admitHistoricalFixture } from '../helpers/historical-admission.js'

const cleanups: Array<() => Promise<void>> = []
const configuredSecretName = 'GEAR_STANDALONE_EXPERIENCE_TEST_SECRET'
const configuredSecretValue = 'standalone-experience-secret-needle'
const canListenLoopback = spawnSync(process.execPath, ['-e', "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>n.close(()=>process.exit(0)));n.on('error',()=>process.exit(1))"]).status === 0
const hasSandbox = (process.platform === 'darwin' || process.platform === 'linux')
  && SandboxManager.checkDependencies().errors.length === 0 && canListenLoopback
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
})

function identity(runtimeType = 'codex'): SkillHarnessIdentity {
  return {
    runtime: { type: runtimeType, version: 'test', integrity: SHA('1') },
    preset: { id: 'refine', digest: SHA('2') },
    model: { provider: 'openai', model: 'gpt-test' },
    sampling: {},
  }
}

class E2eEvaluator implements RefineEvaluator {
  private serial = 0

  evaluationIdentity(_round: Readonly<RefinementRound>, request: Readonly<EvaluationRequest>) {
    return {
      provider: 'fake',
      effectiveConfigDigest: request.condition.rolloutProviderDigest,
      invocationFingerprint: request.condition.rolloutProviderDigest,
    }
  }

  async reserve(_round: Readonly<RefinementRound>, _request: Readonly<EvaluationRequest>): Promise<EvaluationReservation> {
    this.serial += 1
    return { provider: 'fake', evalId: `eval_${this.serial.toString(16).padStart(32, '0')}` }
  }

  async evaluate(
    _round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    _signal?: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    const candidate = request.phase.endsWith('candidate')
    const rewards = candidate ? [1, 1] : [1, 0]
    const score = rewards.reduce((sum, value) => sum + value, 0) / rewards.length
    const serial = this.serial.toString(16).padStart(32, '0')
    return {
      provider: 'fake',
      conditionId: request.condition.conditionId,
      effectiveConfigDigest: request.condition.rolloutProviderDigest,
      evalId: reservation?.evalId ?? `eval_${serial}`,
      dataset: request.dataset,
      requestedCommit: request.harnessRef,
      actualCommit: request.harnessRef,
      revisionIdentity: SHA(serial),
      invocationFingerprint: request.condition.rolloutProviderDigest,
      completeness: 'complete',
      plannedTrialCount: 2,
      primaryReward: score,
      summary: { total: 2, passed: rewards.filter(value => value > 0).length, failed: rewards.filter(value => value <= 0).length, score },
      trials: rewards.map((reward, index) => ({
        taskName: `task-${index + 1}`,
        trialName: `${request.phase}-task-${index + 1}`,
        runId: `run_${`${serial}${index}`.slice(-32).padStart(32, '0')}`,
        attempt: 1,
        status: 'completed' as const,
        rewards: { reward },
      })),
      invalidTrials: [],
      localSourceTransport: {
        kind: 'local-git-commit',
        resolutionIdentity: SHA(serial),
        commit: request.harnessRef,
        tree: 'f'.repeat(40),
        payloadSha256: SHA('4'),
        payloadBytes: 1,
      },
    }
  }

  async inspectCapabilities(): Promise<HitchCapabilities> {
    return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }
  }

  async inspectTrajectoryAnalysis(runId: string, _signal: AbortSignal): Promise<HitchTrajectoryAnalysis> {
    return trajectoryAnalysis(runId, [{
        type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
        data: {
          role: 'user', id: 'user-1', source: { kind: 'user' },
          content: [{ type: 'text', text: 'missing context caused the failure' }],
        },
    }])
  }

  async inspectTrajectoryEvents(
    runId: string,
    query: Readonly<HitchTrajectoryEventsQuery>,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryEventsPage> {
    return trajectoryEventsPage(await this.inspectTrajectoryAnalysis(runId, signal), query)
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error('condition not reached')
}

describe('refine skill end to end', () => {
  it.each([
    { runtimeType: 'codex', candidate: 'context' },
    { runtimeType: 'claude-code', candidate: 'context' },
    { runtimeType: 'dsh', candidate: 'context' },
    { runtimeType: 'codex', candidate: 'documented skill' },
    { runtimeType: 'codex', candidate: 'documented full harness' },
  ])('lets a $runtimeType Meta harness check, finalize, and promote a $candidate candidate', async ({ runtimeType, candidate }) => {
    const exerciseExperience = runtimeType === 'codex' && candidate === 'context'
    const previousConfiguredSecret = process.env[configuredSecretName]
    if (exerciseExperience) {
      process.env[configuredSecretName] = configuredSecretValue
      cleanups.push(async () => {
        if (previousConfiguredSecret === undefined) delete process.env[configuredSecretName]
        else process.env[configuredSecretName] = previousConfiguredSecret
      })
    }
    const fixture = await createGitHarnessFixture()
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const evaluator = new E2eEvaluator()
    const socketPath = join(fixture.root, 'refine.sock')
    const controlPlane = await createSkillControlPlane(ConfigSchema({
      workspaceRoot: fixture.root,
      dshRepository: fixture.repository,
      targetRoot: fixture.targetRoot,
      stateRoot: join(fixture.root, 'state'),
      metaModel: { provider: 'openai', model: 'gpt-test' },
      metaSampling: {},
      metaAdapter: {
        kind: 'skill',
        runtimeType,
        runtimeVersion: 'test',
        runtimeIntegrity: SHA('1'),
        harnessId: 'refine',
        harnessDigest: SHA('2'),
        socketPath,
        maxRequestBytes: 1024 * 1024,
      },
      dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1',
      seedTaskRef: 'seed',
      heldOutRef: 'held-out',
      taskBudgetMs: 60_000,
      metaSandbox: hasSandbox
        ? { mode: 'required', linuxIsolation: process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp' }
        : { mode: 'disabled' },
      initialChampion: {
        schemaVersion: 2,
        ref: fixture.championRef,
        manifestDigest: fixture.manifest.digest,
        updatedAt: 'initial',
      },
      candidateWorkspace: { shellEnabled: false },
      candidateGeneration: {
        maxCandidates: 1,
        attemptTimeoutMs: 10_000,
        maxAttemptsPerCandidate: 1,
        roundTimeoutMs: 10_000,
      },
      selection: { survivors: 1, timeoutMs: 10_000 },
      compiler: { command: process.execPath, args: [], timeoutMs: 10_000, env: {} },
      hitch: {
        model: 'target-model',
        allowUnavailableVerifierDiagnosis: true,
        passEnv: exerciseExperience ? [configuredSecretName] : [],
      },
      promotion: {
        minimumCandidateScore: 0.7,
        minimumAbsoluteGain: 0.1,
        requireNoRegression: true,
        maxHeldOutRegression: 0,
        maxRequiredRegressions: 0,
      },
    } as never), { evaluator, compiler: new NoopHarnessCompiler() })
    cleanups.push(() => controlPlane.dispose())
    const { service } = controlPlane

    // This fixture exercises the historical non-staged workflow over the live
    // socket; objective V1 admission is covered by the staged control-plane tests.
    const admission = await admitHistoricalFixture(service, 'skill', { rounds: exerciseExperience ? 2 : 1, focus: ['context'] })
    const claim = await eventually(
      () => requestRefineSkill(socketPath, {
        method: 'meta.claim',
        params: { clientId: `${runtimeType}-session`, evolutionId: admission.evolutionId, identity: identity(runtimeType) },
      }) as Promise<Record<string, unknown>>,
      value => typeof value.leaseToken === 'string',
    ) as Record<string, unknown> & { leaseId: string; leaseToken: string; sessionId: string; baseline: { evalId: string; trials: Array<{ runId?: string; reward?: number }> } }
    const lease = { clientId: `${runtimeType}-session`, leaseId: claim.leaseId, leaseToken: claim.leaseToken }
    const failedRun = claim.baseline.trials.find(trial => (trial.reward ?? 0) <= 0)?.runId
    if (failedRun === undefined) throw new Error('baseline has no failed run')

    const trajectoryResult = await requestRefineSkill(socketPath, {
      method: 'meta.call',
      params: { ...lease, capability: 'trajectory.query', arguments: { refs: [failedRun] } },
    })
    expect(trajectoryResult).toMatchObject({
      runs: [{ runId: failedRun }],
      diagnosisProgress: { ready: true, diagnosed: 1, required: 1, remainingRunIds: [] },
    })
    const observed = await requestRefineSkill(socketPath, {
      method: 'candidate.read', params: { ...lease, path: 'plugins/context.ts' },
    }) as { digest: string }
    await requestRefineSkill(socketPath, {
      method: 'candidate.edit',
      params: {
        ...lease,
        path: 'plugins/context.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
        expectedDigest: observed.digest,
      },
    })
    const documentedFiles = candidate === 'documented full harness' ? await documentedHarnessCandidate()
      : candidate === 'documented skill' ? await documentedSkillCandidate() : {}
    for (const [path, content] of Object.entries(documentedFiles)) {
      const existing = path === 'preset/agent.cordis.yml'
        ? await requestRefineSkill(socketPath, {
            method: 'candidate.read', params: { ...lease, path },
          }) as { digest: string }
        : undefined
      await requestRefineSkill(socketPath, {
        method: 'candidate.write',
        params: { ...lease, path, text: content, expectedDigest: existing?.digest ?? null },
      })
    }
    if (candidate === 'documented full harness') {
      const path = './skills/verify-change/scripts/__init__.py'
      await requestRefineSkill(socketPath, {
        method: 'candidate.write', params: { ...lease, path, text: '', expectedDigest: null },
      })
      const read = () => requestRefineSkill(socketPath, {
        method: 'candidate.read', params: { ...lease, path },
      }) as Promise<{ digest: string; text: string }>
      const empty = await read()
      await requestRefineSkill(socketPath, {
        method: 'candidate.write', params: { ...lease, path, text: 'old', expectedDigest: empty.digest },
      })
      await requestRefineSkill(socketPath, {
        method: 'candidate.edit', params: { ...lease, path, oldString: 'old', newString: '$&', expectedDigest: (await read()).digest },
      })
      expect((await read()).text).toBe('$&')
      await requestRefineSkill(socketPath, {
        method: 'candidate.write', params: { ...lease, path, text: '', expectedDigest: (await read()).digest },
      })
      expect(await read()).toEqual(empty)
      await requestRefineSkill(socketPath, {
        method: 'candidate.remove', params: { ...lease, path, expectedDigest: empty.digest },
      })
    }
    await expect(requestRefineSkill(socketPath, {
      method: 'meta.call', params: { ...lease, capability: 'candidate.check', arguments: { check: 'compiler' } },
    })).resolves.toMatchObject({ ok: true, finalizationReadiness: { ready: true, remainingRunCount: 0 } })
    await expect(requestRefineSkill(socketPath, {
      method: 'meta.call', params: { ...lease, capability: 'candidate.diff', arguments: {} },
    })).resolves.toMatchObject({ summary: { files: expect.arrayContaining(
      ['plugins/context.ts', ...Object.keys(documentedFiles)].map(path => expect.objectContaining({ path })),
    ) } })
    await requestRefineSkill(socketPath, {
      method: 'meta.call',
      params: {
        ...lease,
        capability: 'candidate.finalize',
        arguments: {
          rationale: exerciseExperience
            ? `The failed seed run lacked the required context. ${configuredSecretValue}`
            : 'The failed seed run lacked the required context.',
          expectedOutcome: 'The target uses the corrected context.',
          evidenceRefs: [claim.baseline.evalId, failedRun],
          semanticTargets: ['context'],
        },
      },
    })

    const terminal = await eventually(
      () => requestRefineSkill(socketPath, {
        method: 'control.status', params: { evolutionId: admission.evolutionId, roundId: admission.roundId },
      }) as Promise<Record<string, unknown>>,
      value => value.status === 'accepted',
    )
    expect(terminal).toMatchObject({ status: 'accepted', decision: 'accepted' })
    const stored = await service.registry.stateStore(admission.evolutionId).readRound(admission.roundId)
    expect(stored?.candidatePool[0]?.meta?.source).toMatchObject({
      kind: 'skill-lease', harness: runtimeType, clientId: `${runtimeType}-session`, leaseId: claim.leaseId,
    })
    expect((await service.registry.stateStore(admission.evolutionId).readChampion())?.ref).toBe(stored?.candidatePool[0]?.sealedVersion?.commitOid)
    const sealed = stored!.candidatePool[0]!.sealedVersion!
    const manifest = await service.builder.readManifest(sealed.commitOid)
    expect(manifest.artifacts).toEqual(expect.arrayContaining(
      Object.keys(documentedFiles).map(path => expect.objectContaining({ path })),
    ))
    for (const [path, content] of Object.entries(documentedFiles)) {
      expect((await service.builder.readHarnessFile(sealed.commitOid, path)).content).toBe(content)
    }

    if (exerciseExperience) {
      const next = await eventually(
        () => requestRefineSkill(socketPath, {
          method: 'meta.claim',
          params: { clientId: `${runtimeType}-session`, evolutionId: admission.evolutionId, identity: identity(runtimeType) },
        }) as Promise<Record<string, unknown>>,
        value => typeof value.leaseToken === 'string' && value.roundId !== admission.roundId,
      ) as Record<string, unknown> & {
        leaseId: string
        leaseToken: string
        roundId: string
        baseline: { evalId: string; trials: Array<{ runId?: string; reward?: number }> }
        experienceContext: {
          snapshotDigest: string
          directParent: { experienceRef: string; source: { candidateId: string } }
          relevantCards: Array<{ markdown: string }>
        }
      }
      expect(next.experienceContext).toMatchObject({
        snapshotDigest: expect.stringMatching(/^sha256:/u),
        directParent: { source: { candidateId: stored!.candidatePool[0]!.candidateId } },
      })
      const claimedCards = JSON.stringify([
        next.experienceContext.directParent,
        ...next.experienceContext.relevantCards,
      ])
      expect(claimedCards).not.toContain(configuredSecretValue)
      expect(claimedCards).toContain('[REDACTED]')
      const nextLease = {
        clientId: `${runtimeType}-session`, leaseId: next.leaseId, leaseToken: next.leaseToken,
      }
      const history = await requestRefineSkill(socketPath, {
        method: 'meta.call',
        params: {
          ...nextLease,
          capability: 'experience.query',
          arguments: { taskNames: ['task-2'], effects: ['improved'], limit: 3 },
        },
      }) as { snapshotDigest: string; results: Array<{ experienceRef: string; effect: string }> }
      expect(history).toMatchObject({
        snapshotDigest: next.experienceContext.snapshotDigest,
        results: [{ experienceRef: next.experienceContext.directParent.experienceRef, effect: 'improved' }],
      })
      await expect(requestRefineSkill(socketPath, {
        method: 'meta.call',
        params: {
          ...nextLease,
          capability: 'experience.read',
          arguments: { ref: history.results[0]!.experienceRef, view: 'task-results', limit: 10 },
        },
      })).resolves.toMatchObject({
        available: true,
        snapshotDigest: next.experienceContext.snapshotDigest,
        coverage: { planned: 2, valid: 2, excluded: 0 },
      })

      const nextFailedRuns = next.baseline.trials
        .filter(trial => (trial.reward ?? 0) <= 0 && trial.runId !== undefined)
        .map(trial => trial.runId!)
      await expect(requestRefineSkill(socketPath, {
        method: 'meta.call', params: { ...nextLease, capability: 'candidate.check', arguments: { check: 'compiler' } },
      })).resolves.toMatchObject({
        finalizationReadiness: {
          ready: nextFailedRuns.length === 0,
          remainingRunCount: nextFailedRuns.length,
        },
      })
      if (nextFailedRuns.length > 0) {
        await requestRefineSkill(socketPath, {
          method: 'meta.call',
          params: { ...nextLease, capability: 'trajectory.query', arguments: { refs: nextFailedRuns } },
        })
      }

      const nextObserved = await requestRefineSkill(socketPath, {
        method: 'candidate.read', params: { ...nextLease, path: 'plugins/context.ts' },
      }) as { digest: string }
      await requestRefineSkill(socketPath, {
        method: 'candidate.edit',
        params: {
          ...nextLease,
          path: 'plugins/context.ts',
          oldString: 'value = 2',
          newString: 'value = 3',
          expectedDigest: nextObserved.digest,
        },
      })
      await requestRefineSkill(socketPath, {
        method: 'meta.call', params: { ...nextLease, capability: 'candidate.check', arguments: { check: 'compiler' } },
      })
      await requestRefineSkill(socketPath, {
        method: 'meta.call',
        params: {
          ...nextLease,
          capability: 'candidate.finalize',
          arguments: {
            rationale: 'Try a further context refinement.',
            expectedOutcome: 'Preserve the already improved seed behavior.',
            evidenceRefs: [next.baseline.evalId, ...nextFailedRuns],
            semanticTargets: ['context'],
          },
        },
      })
      const nextTerminal = await eventually(
        () => requestRefineSkill(socketPath, {
          method: 'control.status', params: { evolutionId: admission.evolutionId, roundId: next.roundId },
        }) as Promise<Record<string, unknown>>,
        value => ['accepted', 'rejected', 'rejected-for-substrate', 'failed'].includes(String(value.status)),
      )
      expect(nextTerminal).toMatchObject({ status: expect.stringMatching(/^(?:accepted|rejected)$/u) })
    }
  })
})
