import { randomBytes } from 'node:crypto'
import type { RefineStateStore } from '../state/store.js'
import { digestJson } from '../state/digest.js'
import type {
  CandidateRecord,
  EvaluationEvidence,
  MetaAgentSpec,
  MetaAttribution,
  MetaCheckpointRef,
  ProposalEvidenceAudit,
  RefinementRound,
} from '../types.js'
import type { MetaAgentSession, MetaSessionController } from './controller.js'

export interface SkillHarnessIdentity {
  runtime: { type: string; version: string; integrity: string }
  preset: { id: string; digest: string }
  model: { provider: string; model: string; maxTokens?: number }
  sampling?: { temperature?: number }
}

export interface SkillAssignment {
  leaseId: string
  evolutionId: string
  roundId: string
  candidateId: string
  sessionId: string
  workspaceId: string
  parentHarnessRef: string
  parentHarnessDigest: string
  evidencePolicy: {
    currentRoundOnly: true
    citeObservedSeedRefs: true
    diagnoseEveryFailedRunBeforeProposal: true
    heldOutUnavailable: true
  }
  baseline: {
    evalId: string
    primaryReward: number
    summary: EvaluationEvidence['summary']
    trials: Array<{
      taskName: string
      trialName?: string
      runId?: string
      attempt?: number
      status: 'completed' | 'errored'
      reward?: number
      invalidReason?: string
    }>
  }
  advisoryFocus?: RefinementRound['advisoryFocus']
  batch: { id: string; index: number; count: number }
}

export interface ClaimedSkillAssignment extends SkillAssignment {
  leaseToken: string
}

interface AssignmentEntry {
  assignment: SkillAssignment
  expectedIdentity: SkillHarnessIdentity
  token: string
  clientId?: string
  identity?: SkillHarnessIdentity
  onClaim(): void
}

function trialReward(trial: EvaluationEvidence['trials'][number]): number | undefined {
  return trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

function expectedIdentity(spec: MetaAgentSpec): SkillHarnessIdentity {
  return {
    runtime: { ...spec.runtime },
    preset: { id: spec.preset.id, digest: spec.preset.digest },
    model: { ...spec.model },
    sampling: { ...spec.sampling },
  }
}

function identityDigest(identity: SkillHarnessIdentity): string {
  return digestJson(identity)
}

/** In-memory lease broker shared by every skill-backed evolution runtime. */
export class SkillMetaCoordinator {
  private readonly entries = new Map<string, AssignmentEntry>()
  private readonly bySession = new Map<string, string>()

  publish(
    assignment: SkillAssignment,
    identity: SkillHarnessIdentity,
    onClaim: () => void,
  ): void {
    if (this.bySession.has(assignment.sessionId)) throw new Error('Meta skill session already has an assignment')
    this.entries.set(assignment.leaseId, {
      assignment: structuredClone(assignment),
      expectedIdentity: structuredClone(identity),
      token: randomBytes(32).toString('hex'),
      onClaim,
    })
    this.bySession.set(assignment.sessionId, assignment.leaseId)
  }

  claim(clientId: string, identity: SkillHarnessIdentity, evolutionId?: string): ClaimedSkillAssignment | undefined {
    if (clientId.length === 0) throw new TypeError('clientId is required')
    const available = [...this.entries.values()].filter(value =>
      (evolutionId === undefined || value.assignment.evolutionId === evolutionId)
      && (value.clientId === undefined || value.clientId === clientId),
    )
    const requestedDigest = identityDigest(identity)
    const entry = available.find(value => requestedDigest === identityDigest(value.expectedIdentity))
    if (entry === undefined) {
      if (available.length > 0) throw new Error('Meta harness identity does not match the immutable evolution spec')
      return undefined
    }
    if (entry.clientId === undefined) {
      entry.clientId = clientId
      entry.identity = structuredClone(identity)
      entry.onClaim()
    }
    return { ...structuredClone(entry.assignment), leaseToken: entry.token }
  }

  authorize(leaseId: string, leaseToken: string, clientId: string): SkillAssignment {
    const entry = this.entries.get(leaseId)
    if (entry === undefined || entry.token !== leaseToken || entry.clientId !== clientId) {
      throw new Error('invalid or stale Meta skill lease')
    }
    return structuredClone(entry.assignment)
  }

  attribution(sessionId: string): { clientId: string; identity: SkillHarnessIdentity; leaseId: string } {
    const leaseId = this.bySession.get(sessionId)
    const entry = leaseId === undefined ? undefined : this.entries.get(leaseId)
    if (leaseId === undefined || entry?.clientId === undefined || entry.identity === undefined) {
      throw new Error('Meta skill assignment has not been claimed')
    }
    return { clientId: entry.clientId, identity: structuredClone(entry.identity), leaseId }
  }

  release(sessionId: string): void {
    const leaseId = this.bySession.get(sessionId)
    if (leaseId === undefined) return
    this.bySession.delete(sessionId)
    this.entries.delete(leaseId)
  }

  pending(): SkillAssignment[] {
    return [...this.entries.values()].map(value => structuredClone(value.assignment))
  }
}

interface WakeState {
  roundId: string
  candidateId?: string
  baselineEvalId: string
  summaryAccessed: boolean
  accessedRefs: Set<string>
  diagnosedRunRefs: Set<string>
}

export interface SkillMetaSessionOptions {
  evolutionId: string
  specDigest: string
  metaAgent: MetaAgentSpec
}

/** Meta session adapter driven by a skill running in any compatible harness. */
export class SkillMetaSessionManager implements MetaSessionController {
  private rootSessionId: string | undefined
  private readonly sessions = new Set<string>()
  private readonly wakes = new Map<string, WakeState>()

  constructor(
    private readonly store: RefineStateStore,
    private readonly coordinator: SkillMetaCoordinator,
    readonly options: SkillMetaSessionOptions,
  ) {}

  async agent(): Promise<MetaAgentSession> {
    if (this.rootSessionId !== undefined) return { id: this.rootSessionId }
    const persisted = await this.store.readMeta()
    const sessionId = persisted?.evolutionId === this.options.evolutionId
      && persisted.specDigest === this.options.specDigest
      && persisted.metaHarnessRef === this.options.metaAgent.preset.id
      ? persisted.sessionId
      : crypto.randomUUID()
    this.rootSessionId = sessionId
    this.sessions.add(sessionId)
    await this.store.writeMeta({
      evolutionId: this.options.evolutionId,
      sessionId,
      metaHarnessRef: this.options.metaAgent.preset.id,
      specDigest: this.options.specDigest,
    })
    return { id: sessionId }
  }

  async checkpoint(sessionId?: string): Promise<MetaCheckpointRef> {
    const id = sessionId ?? (await this.agent()).id
    if (!this.sessions.has(id)) throw new Error(`unknown Meta skill session: ${id}`)
    const checkpoint = {
      sourceSessionId: id,
      eventCount: 0,
      prefixDigest: digestJson({
        kind: 'skill-session',
        evolutionId: this.options.evolutionId,
        specDigest: this.options.specDigest,
        sessionId: id,
      }),
    }
    const persisted = await this.store.readMeta()
    if (persisted?.sessionId === id) await this.store.writeMeta({ ...persisted, checkpoint })
    return checkpoint
  }

  async fork(checkpoint: MetaCheckpointRef): Promise<MetaAgentSession> {
    if (!this.sessions.has(checkpoint.sourceSessionId)) {
      // Population checkpoints survive controller restarts. Their immutable
      // digest is enough for the stateless skill adapter to continue lineage.
      this.sessions.add(checkpoint.sourceSessionId)
    }
    const session = { id: crypto.randomUUID() }
    this.sessions.add(session.id)
    return session
  }

  async cancel(sessionId: string, _reason: string): Promise<void> {
    this.coordinator.release(sessionId)
    this.wakes.delete(sessionId)
  }

  async release(sessionId: string): Promise<void> {
    if (sessionId === this.rootSessionId) return
    this.coordinator.release(sessionId)
    this.wakes.delete(sessionId)
    this.sessions.delete(sessionId)
  }

  async dispose(): Promise<void> {
    for (const sessionId of this.sessions) this.coordinator.release(sessionId)
    this.sessions.clear()
    this.wakes.clear()
    this.rootSessionId = undefined
  }

  async wake(round: Readonly<RefinementRound>): Promise<string> {
    const candidate = round.candidatePool.find(value => value.status === 'generating')
    return this.wakeCandidate(round, candidate, round.baseline, await this.agent())
  }

  async wakeCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<CandidateRecord> | undefined,
    baseline: EvaluationEvidence | undefined,
    session: MetaAgentSession,
  ): Promise<string> {
    if (round.evolutionId !== this.options.evolutionId) throw new Error('Meta skill session received a foreign evolution')
    if (candidate?.workspaceId === undefined || baseline === undefined) throw new Error('Meta skill assignment is incomplete')
    const allocation = round.parentAllocations?.find(value => value.candidateId === candidate.candidateId)
    if (allocation === undefined) throw new Error('Meta skill assignment has no parent allocation')
    const state: WakeState = {
      roundId: round.roundId,
      candidateId: candidate.candidateId,
      baselineEvalId: baseline.evalId,
      summaryAccessed: false,
      accessedRefs: new Set(),
      diagnosedRunRefs: new Set(),
    }
    this.wakes.set(session.id, state)
    const refs = [
      baseline.evalId,
      ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...baseline.invalidTrials.map(trial => trial.runId),
    ]
    const leaseId = crypto.randomUUID()
    this.coordinator.publish({
      leaseId,
      evolutionId: round.evolutionId,
      roundId: round.roundId,
      candidateId: candidate.candidateId,
      sessionId: session.id,
      workspaceId: candidate.workspaceId,
      parentHarnessRef: candidate.parentHarnessRef,
      parentHarnessDigest: allocation.parentHarnessDigest,
      evidencePolicy: {
        currentRoundOnly: true,
        citeObservedSeedRefs: true,
        diagnoseEveryFailedRunBeforeProposal: true,
        heldOutUnavailable: true,
      },
      baseline: {
        evalId: baseline.evalId,
        primaryReward: baseline.primaryReward,
        summary: structuredClone(baseline.summary),
        trials: [
          ...baseline.trials.map(trial => {
            const reward = trialReward(trial)
            return {
              taskName: trial.taskName,
              ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
              ...(trial.runId === undefined ? {} : { runId: trial.runId }),
              ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
              status: trial.status,
              ...(reward === undefined ? {} : { reward }),
            }
          }),
          ...baseline.invalidTrials.map(trial => ({ ...trial })),
        ],
      },
      ...(round.advisoryFocus === undefined ? {} : { advisoryFocus: [...round.advisoryFocus] }),
      batch: { id: round.batchId, index: round.roundIndex, count: round.roundCount },
    }, expectedIdentity(this.options.metaAgent), () => {
      state.summaryAccessed = true
      for (const ref of refs) state.accessedRefs.add(ref)
    })
    return session.id
  }

  activeRoundId(sessionId: string): string | undefined {
    return this.wakes.get(sessionId)?.roundId
  }

  recordEvidenceAccess(
    roundId: string,
    sessionId: string,
    access: { summary?: boolean; refs?: readonly string[]; diagnosedRunRefs?: readonly string[] },
  ): void {
    const state = this.wakes.get(sessionId)
    if (state === undefined || state.roundId !== roundId) return
    if (access.summary === true) state.summaryAccessed = true
    for (const ref of access.refs ?? []) state.accessedRefs.add(ref)
    for (const ref of access.diagnosedRunRefs ?? []) state.diagnosedRunRefs.add(ref)
  }

  proposalEvidenceAudit(roundId: string, sessionId: string, citedRefs: readonly string[]): ProposalEvidenceAudit {
    const state = this.wakes.get(sessionId)
    if (state === undefined || state.roundId !== roundId) throw new Error('proposal did not originate from the active Meta skill lease')
    return {
      evolutionId: this.options.evolutionId,
      roundId,
      ...(state.candidateId === undefined ? {} : { candidateId: state.candidateId }),
      baselineEvalId: state.baselineEvalId,
      summaryAccessed: state.summaryAccessed,
      accessedRefs: [...state.accessedRefs].sort(),
      diagnosedRunRefs: [...state.diagnosedRunRefs].sort(),
      citedRefs: [...citedRefs],
    }
  }

  proposalAttribution(roundId: string, sessionId: string, _mutation: unknown): MetaAttribution {
    const state = this.wakes.get(sessionId)
    if (state === undefined || state.roundId !== roundId) throw new Error('proposal did not originate from the active Meta skill lease')
    const claim = this.coordinator.attribution(sessionId)
    return {
      evolutionId: this.options.evolutionId,
      sessionId,
      source: {
        kind: 'skill-lease',
        harness: claim.identity.runtime.type,
        clientId: claim.clientId,
        leaseId: claim.leaseId,
      },
      provider: claim.identity.model.provider,
      model: claim.identity.model.model,
      ...(claim.identity.model.maxTokens === undefined ? {} : { maxTokens: claim.identity.model.maxTokens }),
      ...(claim.identity.sampling === undefined ? {} : { sampling: { ...claim.identity.sampling } }),
    }
  }
}
