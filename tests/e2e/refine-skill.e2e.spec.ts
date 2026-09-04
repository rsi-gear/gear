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
import { SHA } from '../helpers/research-fixture.js'
import { trajectoryAnalysis, trajectoryEventsPage } from '../helpers/trajectory-fixture.js'

const cleanups: Array<() => Promise<void>> = []
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
  it.each(['codex', 'claude-code'])('lets a %s Meta harness claim, edit, diagnose, finalize, evaluate, and promote', async runtimeType => {
    const fixture = await createGitHarnessFixture()
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
    const evaluator = new E2eEvaluator()
    const socketPath = join(fixture.root, 'refine.sock')
    const controlPlane = await createSkillControlPlane(ConfigSchema({
      workspaceRoot: fixture.root,
      dshRepository: fixture.repository,
      targetRoot: fixture.targetRoot,
      stateRoot: join(fixture.root, 'state'),
      metaPreset: 'refine',
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
      hitch: { model: 'target-model', allowUnavailableVerifierDiagnosis: true },
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

    const admission = await requestRefineSkill(socketPath, {
      method: 'control.start', params: { rounds: 1, focus: ['context'] },
    }) as { evolutionId: string; roundId: string }
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
    await expect(requestRefineSkill(socketPath, {
      method: 'meta.call', params: { ...lease, capability: 'candidate.check', arguments: { check: 'compiler' } },
    })).resolves.toMatchObject({ ok: true, finalizationReadiness: { ready: true, remainingRunCount: 0 } })
    await expect(requestRefineSkill(socketPath, {
      method: 'meta.call', params: { ...lease, capability: 'candidate.diff', arguments: {} },
    })).resolves.toMatchObject({ summary: { files: [expect.objectContaining({ path: 'plugins/context.ts' })] } })
    await requestRefineSkill(socketPath, {
      method: 'meta.call',
      params: {
        ...lease,
        capability: 'candidate.finalize',
        arguments: {
          rationale: 'The failed seed run lacked the required context.',
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
  })
})
