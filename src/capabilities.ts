import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { MetaSessionManager } from './meta/session.js'
import type { HarnessBuilder } from './harness/builder.js'
import type { RefineService } from './refine/service.js'
import type { RefineStateStore } from './state/store.js'
import type {
  HitchEvaluationEvidence,
  HitchTrajectoryReader,
  HitchTrialSummary,
  RefineBridgeRequestMap,
  SessionRole,
} from './types.js'

export interface CapabilityOptions {
  seedTasksPath?: string
  maxReadBytes?: number
  maxTrajectoryPageBytes?: number
  trajectoryReader?: HitchTrajectoryReader
  secretValues?: readonly string[]
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('capability params must be an object')
  return value as Record<string, unknown>
}

function publicJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (key, item) => /heldOut|held_out|partitionRef/iu.test(key) ? undefined : item)) as JsonValue
}

interface SeedRunEvidence {
  roundId: string
  phase: 'seed-baseline' | 'seed-candidate'
  evalId: string
  trial: HitchTrialSummary & { runId: string }
}

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/iu

export class RefineCapabilities {
  private readonly maxReadBytes: number
  private readonly maxTrajectoryPageBytes: number
  private readonly secretValues: readonly string[]

  constructor(
    private readonly service: RefineService,
    private readonly store: RefineStateStore,
    private readonly meta: MetaSessionManager,
    private readonly builder: HarnessBuilder,
    private readonly resolveAgent: (sessionId: string) => Agent | undefined,
    private readonly options: CapabilityOptions = {},
  ) {
    this.maxReadBytes = options.maxReadBytes ?? 128 * 1024
    this.maxTrajectoryPageBytes = options.maxTrajectoryPageBytes ?? this.maxReadBytes
    this.secretValues = (options.secretValues ?? []).filter(value => value.length > 0)
  }

  async call(
    role: SessionRole,
    sessionId: string,
    method: string,
    params: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    const args = record(params)
    if (role === 'refine-meta') return this.callMeta(sessionId, method, args, signal)
    if (role === 'target') {
      if (method === 'refine.run') return this.service.admit('target')
      if (method === 'refine.status') return this.service.status(this.string(args, 'roundId'))
    }
    throw new Error(`capability is unavailable for ${role}: ${method}`)
  }

  private async callMeta(
    sessionId: string,
    method: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (method === 'harness.current') {
      const champion = await this.store.readChampion()
      if (champion === undefined) throw new Error('no champion is initialized')
      const manifest = await this.builder.readManifest(champion.ref)
      if (manifest.digest !== champion.manifestDigest) throw new Error('champion manifest digest does not match its Git commit')
      return publicJson({ ref: champion.ref, digest: champion.manifestDigest, manifest })
    }
    if (method === 'harness.read') {
      const champion = await this.store.readChampion()
      if (champion === undefined || args.ref !== champion.ref) throw new Error('harness ref is not the current champion')
      const path = this.string(args, 'path')
      const { content } = await this.builder.readHarnessFile(champion.ref, path)
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? this.maxReadBytes, this.maxReadBytes)
      return { ref: champion.ref, path, offset, text: content.slice(offset, offset + limit), eof: offset + limit >= content.length }
    }
    if (method === 'seed_tasks.load') {
      if (this.options.seedTasksPath === undefined) return { tasks: [] }
      return publicJson(JSON.parse(await readFile(this.options.seedTasksPath, 'utf8')))
    }
    if (method === 'trajectory.query') {
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? 20, 100)
      if (limit <= 0) throw new TypeError('limit must be a positive integer')
      const rounds = await this.store.listRounds()
      const evidence = this.seedRunEvidence(rounds)
      const refs = this.optionalStrings(args, 'refs')
      if (refs === undefined || refs.length === 0) {
        const projected = rounds.slice(offset, offset + limit).map(round => ({
          roundId: round.roundId,
          status: round.status,
          targetHarnessRef: round.targetHarnessRef,
          seedEvidence: [
            ...(round.baseline === undefined ? [] : [this.projectEvidence('seed-baseline', round.baseline)]),
            ...(round.evaluation?.seedCandidate === undefined ? [] : [this.projectEvidence('seed-candidate', round.evaluation.seedCandidate)]),
          ],
          scoreDelta: round.evaluation?.scoreDelta,
          decision: round.decision,
          failure: round.failure === undefined ? undefined : { phase: round.failure.phase },
        }))
        return publicJson({ rounds: projected, offset, limit, eof: offset + projected.length >= rounds.length })
      }
      if (refs.length > 10) throw new TypeError('trajectory.query accepts at most 10 refs')
      if (this.options.trajectoryReader === undefined) throw new Error('Hitch trajectory reader is unavailable')
      const selected = this.resolveSeedRefs(refs, evidence)
      const trajectories = []
      for (const item of selected) {
        const page = await this.options.trajectoryReader.inspectTrajectory(item.trial.runId, offset, limit, signal)
        const bounded = this.boundTrajectoryPage(page.header, page.events, roundHeldOutRef(rounds, item.roundId))
        const consumed = bounded.events.length
        trajectories.push({
          ref: item.trial.runId,
          roundId: item.roundId,
          phase: item.phase,
          evalId: item.evalId,
          taskName: item.trial.taskName,
          trialName: item.trial.trialName,
          runId: page.runId,
          fidelity: page.fidelity,
          provider: page.provider,
          sessionId: page.sessionId,
          ...(offset === 0 ? { header: bounded.header } : {}),
          events: bounded.events,
          offset,
          limit,
          total: page.total,
          nextOffset: offset + consumed,
          eof: page.eof && consumed === page.events.length,
        })
      }
      return publicJson({ trajectories })
    }
    if (method === 'hitch.status') return this.service.status(this.string(args, 'roundId'))
    if (method === 'submit_refinement_proposal') {
      const roundId = this.string(args, 'roundId')
      const agent = this.resolveAgent(sessionId)
      if (agent === undefined) throw new Error('meta session is not live')
      const mutation = args.mutation === null || args.mutation === undefined
        ? null
        : this.builder.validateMutation(args.mutation)
      const attribution = this.meta.proposalAttribution(roundId, agent, mutation)
      await this.service.submitProposal(roundId, mutation, attribution)
      return { accepted: true, roundId }
    }
    throw new Error(`unknown refine-meta capability: ${method}`)
  }

  private seedRunEvidence(rounds: Awaited<ReturnType<RefineStateStore['listRounds']>>): SeedRunEvidence[] {
    const values: SeedRunEvidence[] = []
    for (const round of rounds) {
      const append = (phase: SeedRunEvidence['phase'], evidence: HitchEvaluationEvidence | undefined): void => {
        if (evidence === undefined) return
        for (const trial of evidence.trials) {
          if (trial.runId !== undefined) values.push({ roundId: round.roundId, phase, evalId: evidence.evalId, trial: { ...trial, runId: trial.runId } })
        }
      }
      append('seed-baseline', round.baseline)
      append('seed-candidate', round.evaluation?.seedCandidate)
    }
    return values
  }

  private resolveSeedRefs(refs: string[], evidence: SeedRunEvidence[]): SeedRunEvidence[] {
    const selected = new Map<string, SeedRunEvidence>()
    for (const ref of refs) {
      const matches = evidence.filter(item => item.evalId === ref || item.trial.runId === ref)
      if (matches.length === 0) throw new Error(`trajectory ref is not recorded seed evidence: ${ref}`)
      for (const item of matches) selected.set(item.trial.runId, item)
    }
    return [...selected.values()]
  }

  private projectEvidence(phase: SeedRunEvidence['phase'], evidence: HitchEvaluationEvidence): unknown {
    return {
      phase,
      evalId: evidence.evalId,
      harnessRef: evidence.actualCommit,
      primaryReward: evidence.primaryReward,
      summary: evidence.summary,
      trials: evidence.trials.map(trial => ({
        taskName: trial.taskName,
        trialName: trial.trialName,
        runId: trial.runId,
        attempt: trial.attempt,
        status: trial.status,
        rewards: trial.rewards,
      })),
    }
  }

  private boundTrajectoryPage(header: unknown, events: unknown[], heldOutRef: string | undefined): {
    header: JsonValue
    events: JsonValue[]
  } {
    const sanitizedHeader = this.sanitize(header, heldOutRef)
    const bounded: JsonValue[] = []
    let bytes = Buffer.byteLength(JSON.stringify(sanitizedHeader))
    for (const event of events) {
      let sanitized = this.sanitize(event, heldOutRef)
      let eventBytes = Buffer.byteLength(JSON.stringify(sanitized))
      if (eventBytes > this.maxTrajectoryPageBytes) {
        const source = record(event)
        sanitized = publicJson({
          type: source.type,
          seq: source.seq,
          time: source.time,
          data: { truncated: true, originalBytes: eventBytes },
        })
        eventBytes = Buffer.byteLength(JSON.stringify(sanitized))
      }
      if (bounded.length > 0 && bytes + eventBytes > this.maxTrajectoryPageBytes) break
      bounded.push(sanitized)
      bytes += eventBytes
    }
    return { header: sanitizedHeader, events: bounded }
  }

  private sanitize(value: unknown, heldOutRef: string | undefined, key?: string): JsonValue {
    if (key !== undefined && SENSITIVE_KEY.test(key)) return '[REDACTED]'
    if (typeof value === 'string') {
      let text = value
      for (const secret of this.secretValues) text = text.split(secret).join('[REDACTED]')
      if (heldOutRef !== undefined && heldOutRef.length > 0) text = text.split(heldOutRef).join('[REDACTED_HELD_OUT]')
      return text
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map(item => this.sanitize(item, heldOutRef))
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.sanitize(item, heldOutRef, name)])) as JsonValue
    }
    return String(value)
  }

  private string(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} must be a non-empty string`)
    return value
  }

  private optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative integer`)
    return value as number
  }

  private optionalStrings(args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
      throw new TypeError(`${key} must be an array of non-empty strings`)
    }
    return value as string[]
  }
}

function roundHeldOutRef(
  rounds: Awaited<ReturnType<RefineStateStore['listRounds']>>,
  roundId: string,
): string | undefined {
  return rounds.find(round => round.roundId === roundId)?.heldOutRef
}

export type CapabilityMethod = keyof RefineBridgeRequestMap
