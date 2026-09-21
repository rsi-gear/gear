import { readFile } from 'node:fs/promises'
import { seedOnlyStatus } from './search/public-status.js'
import { createHash, randomBytes } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { HarnessBuilder } from './harness/builder.js'
import { CompilerCheckError, candidateCheckReport, uncheckedRuntime, type CandidateCheckReport } from './harness/check-report.js'
import type { RefineService } from './refine/service.js'
import { projectTrajectory } from './evaluator/trajectory-projection.js'
import { digestJson } from './state/digest.js'
import type { CandidateDiagnosisRecord } from './state/candidate-diagnosis.js'
import { finalizationReadiness, receiptIsValid, recoveryRequired } from './refine/finalization-readiness.js'
import type { RefineStateStore } from './state/store.js'
import { previewVerifierFeedback, previewVerifierProcess } from './meta/verifier-preview.js'
import { PUBLIC_SENSITIVE_KEY, sanitizePublicValue } from './meta/sanitize.js'
import {
  EXPERIENCE_V1_MAX_CARD_BYTES,
  EXPERIENCE_V1_MAX_QUERY_BYTES,
  EXPERIENCE_V1_MAX_QUERY_RESULTS,
  EXPERIENCE_V1_MAX_READ_BYTES,
  EXPERIENCE_V1_MAX_READ_ITEMS,
  experienceDigestFromRef,
  loadSeedExperienceSnapshot,
  rankSeedExperience,
  renderSeedExperienceCard,
  type SeedExperienceQuery,
} from './experience/memory.js'
import type {
  CandidateFinalization,
  ContentExcerpt,
  DiagnosisReceipt,
  EvaluationEvidence,
  HitchTrajectoryReader,
  HitchVerifierDiagnosticPageQuery,
  HitchVerifierEvidence,
  MetaPrerequisiteBlocked,
  MetaPrerequisiteFailure,
  MetaEvidenceText,
  MetaFailureCard,
  RefineBridgeRequestMap,
  RefinementRound,
  SeedExperienceEffect,
  SeedExperienceRecord,
  SemanticTarget,
  SessionRole,
  TrajectoryEvidenceBlocker,
  TrajectoryProjection,
} from './types.js'

export interface CapabilityOptions {
  seedTasksPath?: string
  configuredSeedTaskRef?: string
  maxReadBytes?: number
  maxTrajectoryPageBytes?: number
  maxFailureBundleBytes?: number
  maxTrajectoryCacheEntries?: number
  maxTrajectoryProjectionCacheBytes?: number
  allowUnavailableVerifierDiagnosis?: boolean
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

function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new TypeError(`invalid arguments: unknown field(s): ${extra.join(', ')}`)
}

interface SeedRunEvidence {
  evolutionId: string
  roundId: string
  phase: 'seed-baseline' | 'seed-candidate'
  evalId: string
  trial: {
    passStatus?: EvaluationEvidence['trials'][number]['passStatus']
    taskName: string
    trialName?: string
    runId: string
    attempt?: number
    status: 'completed' | 'errored'
    rewards?: Record<string, number>
    scores?: EvaluationEvidence['trials'][number]['scores']
    invalidReason?: string
  }
  failure?: { code: string; message: string }
}

interface SharedProjectionLoad {
  promise: Promise<TrajectoryProjection>
  controller: AbortController
  waiters: number
  settled: boolean
  bytes: number
}

interface TrajectoryDetailRef {
  sessionId: string
  roundId: string
  runId: string
  offset: number
  text?: string
  sourceComplete?: boolean
  source?: {
    seq: number
    field: string
    canonicalSha256: string
    bytes: number
  }
  verifierSources?: {
    baseText?: string
    artifacts: Array<{
      label: string
      name: HitchVerifierDiagnosticPageQuery['name']
      mediaType: 'application/json' | 'text/plain'
      bytes: number
      sha256: string
    }>
  }
  pendingDiagnosis?: {
    evalId: string
    cardDigest: string
    trajectoryDigest: string
    verifierStatus: DiagnosisReceipt['verifierStatus']
    sourceVerifierStatus: HitchVerifierEvidence['verifier']['status']
    visibleDigests: string[]
    recorded: boolean
    recovery?: Omit<CandidateDiagnosisRecord, 'receipt' | 'source'>
  }
}

const MAX_VERIFIER_DIAGNOSTIC_BYTES = 16 * 1024 * 1024
const VERIFIER_DIAGNOSTIC_PAGE_BYTES = 64 * 1024

interface TrajectoryDetailRead {
  visible: Record<string, unknown>
  diagnosis?: { evalId: string; runId: string; receipt: DiagnosisReceipt; recovery?: Omit<CandidateDiagnosisRecord, 'receipt' | 'source'> }
  blocker?: TrajectoryEvidenceBlocker
}

interface ExperienceQueryCursor {
  sessionId: string
  roundId: string
  snapshotDigest: string
  queryDigest: string
  query: SeedExperienceQuery
  offset: number
  limit: number
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readableMessage(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    try { return readableMessage(JSON.parse(value), depth + 1) }
    catch { return value }
  }
  if (Array.isArray(value)) return value.map(item => readableMessage(item, depth + 1)).filter(Boolean).join('\n')
  const item = objectValue(value)
  if (item === undefined) return String(value)
  if (item.type === 'tool-call') return ''
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) return readableMessage(item.content, depth + 1)
  return JSON.stringify(value, null, 2)
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  const prefix = Buffer.from(value).subarray(0, budget).toString('utf8').replace(/\uFFFD+$/u, '')
  return `${prefix}${suffix}`
}

function splitUtf8Tail(value: string, maxBytes: number): { earlier: string; tail: string } {
  let start = value.length
  let bytes = 0
  const values = Array.from(value)
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const character = values[index]!
    const nextBytes = Buffer.byteLength(character)
    if (bytes + nextBytes > maxBytes) break
    start -= character.length
    bytes += nextBytes
  }
  return { earlier: value.slice(0, start), tail: value.slice(start) }
}

function characters(value: string): string[] {
  return Array.from(value)
}

function characterLength(value: string): number {
  return characters(value).length
}

function boundedCharacters(value: string, maxCharacters: number): string {
  const values = characters(value)
  if (values.length <= maxCharacters) return value
  if (maxCharacters <= 1) return '…'.slice(0, maxCharacters)
  return `${values.slice(0, maxCharacters - 1).join('')}…`
}

function renderedMetaEvidence(value: MetaEvidenceText): string {
  return `${value.text}${value.detailRef === undefined ? '' : `\n[more: ${value.detailRef}]`}`
}

export class RefineCapabilities {
  private readonly maxReadBytes: number
  private readonly maxTrajectoryPageBytes: number
  private readonly secretValues: readonly string[]
  private readonly options: CapabilityOptions
  private readonly trajectoryProjections = new Map<string, SharedProjectionLoad>()
  private readonly trajectoryEvidenceBlockers = new Map<string, TrajectoryEvidenceBlocker>()
  private readonly trajectoryDetailRefs = new Map<string, TrajectoryDetailRef>()
  private readonly experienceQueryCursors = new Map<string, ExperienceQueryCursor>()
  private trajectoryProjectionCacheBytes = 0

  constructor(
    private readonly service: RefineService,
    private readonly builder: HarnessBuilder,
    optionsOrLegacyResolver: CapabilityOptions | ((sessionId: string) => unknown) = {},
    legacyOptions: CapabilityOptions = {},
  ) {
    // The resolver argument was part of the DSH-only API. Keep accepting it so
    // existing plugin consumers can upgrade while attribution moves behind the
    // harness-neutral MetaSessionController contract.
    this.options = typeof optionsOrLegacyResolver === 'function' ? legacyOptions : optionsOrLegacyResolver
    this.maxReadBytes = this.options.maxReadBytes ?? 128 * 1024
    this.maxTrajectoryPageBytes = this.options.maxTrajectoryPageBytes ?? this.maxReadBytes
    if (!Number.isSafeInteger(this.maxTrajectoryPageBytes) || this.maxTrajectoryPageBytes < 4 * 1024) {
      throw new TypeError('maxTrajectoryPageBytes must be an integer of at least 4096 bytes')
    }
    if (this.options.maxFailureBundleBytes !== undefined
      && (!Number.isSafeInteger(this.options.maxFailureBundleBytes) || this.options.maxFailureBundleBytes < 4 * 1024)) {
      throw new TypeError('maxFailureBundleBytes must be an integer of at least 4096 bytes')
    }
    if (this.options.maxTrajectoryCacheEntries !== undefined
      && (!Number.isSafeInteger(this.options.maxTrajectoryCacheEntries) || this.options.maxTrajectoryCacheEntries <= 0)) {
      throw new TypeError('maxTrajectoryCacheEntries must be a positive integer')
    }
    if (this.options.maxTrajectoryProjectionCacheBytes !== undefined
      && (!Number.isSafeInteger(this.options.maxTrajectoryProjectionCacheBytes)
        || this.options.maxTrajectoryProjectionCacheBytes <= 0)) {
      throw new TypeError('maxTrajectoryProjectionCacheBytes must be a positive integer')
    }
    this.secretValues = (this.options.secretValues ?? []).filter(value => value.length > 0)
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
      if (method === 'refine.status') return seedOnlyStatus(await this.service.status(this.string(args, 'evolutionId'), this.optionalString(args, 'roundId')))
    }
    throw new Error(`capability is unavailable for ${role}: ${method}`)
  }

  private async callMeta(
    sessionId: string,
    method: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const active = this.service.activeEntryForSession(sessionId)
    if (active === undefined) throw new Error('Meta session has no active candidate round')
    if (active.signal !== undefined) signal = AbortSignal.any([signal, active.signal])
    signal.throwIfAborted()
    const {
      evolutionId, spec, roundId: activeRoundId, store, meta, workspace,
      baseline,
    } = active
    const champion = active.parentHarnessRef === undefined ? await store.readChampion() : undefined
    const parentHarnessRef = active.parentHarnessRef ?? workspace.parentRef ?? champion?.ref
    const parentHarnessDigest = active.parentHarnessDigest ?? workspace.parentDigest ?? champion?.manifestDigest
    if (method === 'harness.current') {
      if (parentHarnessRef === undefined || parentHarnessDigest === undefined) throw new Error('candidate parent is unavailable')
      const manifest = await this.builder.readManifest(parentHarnessRef)
      if (manifest.digest !== parentHarnessDigest) throw new Error('candidate parent manifest digest does not match its Git commit')
      return publicJson({ ref: parentHarnessRef, digest: parentHarnessDigest, manifest,
        validation: this.builder.validationCapabilities() })
    }
    if (method === 'harness.read') {
      if (parentHarnessRef === undefined) throw new Error('candidate parent is unavailable')
      if (args.ref !== parentHarnessRef) throw new Error('harness ref is not the current candidate parent')
      const path = this.string(args, 'path')
      const { content, digest, bytes } = await this.builder.readHarnessFile(parentHarnessRef, path)
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? this.maxReadBytes, this.maxReadBytes)
      return {
        ref: parentHarnessRef,
        path,
        digest,
        bytes,
        offset,
        text: content.slice(offset, offset + limit),
        eof: offset + limit >= content.length,
      }
    }
    if (method === 'seed_tasks.load') {
      if (args.partition !== undefined && args.partition !== 'seed') {
        throw new TypeError('seed_tasks.load partition must be "seed"')
      }
      if (this.options.configuredSeedTaskRef !== undefined && spec.datasets.seed.ref !== this.options.configuredSeedTaskRef) {
        return { datasetRef: spec.datasets.seed.ref, tasks: [], available: false, reason: 'no typed seed-task projection is configured for this evolution dataset' }
      }
      if (this.options.seedTasksPath === undefined) return { tasks: [] }
      return publicJson(JSON.parse(await readFile(this.options.seedTasksPath, 'utf8')))
    }
    if (method === 'experience.query' || method === 'experience.read') {
      if (spec.experienceMemory?.enabled !== true) {
        throw new Error('seed experience memory is not enabled for this immutable evolution')
      }
      const activeRound = await store.readRound(activeRoundId)
      if (activeRound?.experienceSnapshot === undefined) {
        throw new Error('the active round has no sealed seed experience snapshot')
      }
      const response = await (method === 'experience.query'
        ? this.queryExperience(sessionId, store, activeRound, parentHarnessRef, args)
        : this.readExperience(sessionId, store, activeRound, args, signal))
      return this.experienceResponse(
        response,
        activeRound.heldOutRef,
        method === 'experience.query' ? EXPERIENCE_V1_MAX_QUERY_BYTES : EXPERIENCE_V1_MAX_READ_BYTES,
      )
    }
    if (method === 'trajectory.query') {
      assertOnlyKeys(args, ['refs', 'detailRef', 'find'])
      const refs = this.optionalStrings(args, 'refs')
      const detailRef = this.optionalString(args, 'detailRef')
      const find = this.optionalString(args, 'find')
      if (detailRef !== undefined && refs !== undefined) {
        throw new TypeError('trajectory.query accepts either refs or detailRef, not both')
      }
      if (find !== undefined && detailRef === undefined) {
        throw new TypeError('find requires detailRef')
      }
      const rounds = await store.listRounds()
      if (detailRef !== undefined) {
        const read = await this.readTrajectoryDetail(
          sessionId,
          activeRoundId,
          detailRef,
          find,
          roundHeldOutRef(rounds, activeRoundId),
          signal,
        )
        if (read.blocker !== undefined && baseline !== undefined) {
          await this.persistTrajectoryQueryBlockers(sessionId, activeRoundId, baseline)
        }
        if (read.diagnosis !== undefined) {
          if (read.diagnosis.recovery !== undefined) await this.service.recordCandidateDiagnosis?.(sessionId, {
            ...read.diagnosis.recovery, receipt: read.diagnosis.receipt,
          })
          signal.throwIfAborted()
          meta.recordEvidenceAccess(activeRoundId, sessionId, {
            refs: [read.diagnosis.evalId, read.diagnosis.runId], diagnosisReceipts: [read.diagnosis.receipt],
          })
          await this.service.clearMetaPrerequisiteBlocker?.(sessionId, read.diagnosis.runId)
          const pending = this.trajectoryDetailRefs.get(detailRef)?.pendingDiagnosis
          if (pending !== undefined) pending.recorded = true
        }
        return publicJson(read.visible)
      }
      const evidence: SeedRunEvidence[] = baseline === undefined ? this.seedRunEvidence(rounds) : [
        ...baseline.trials.flatMap(({ originalResult: privateOriginal, ...trial }) => trial.runId === undefined ? [] : [{
          evolutionId,
          roundId: activeRoundId,
          phase: 'seed-baseline' as const,
          evalId: baseline.evalId,
          trial: { ...trial, runId: trial.runId },
        }]),
        ...baseline.invalidTrials.map(({ originalResult: privateOriginal, ...trial }) => ({
          evolutionId,
          roundId: activeRoundId,
          phase: 'seed-baseline' as const,
          evalId: baseline.evalId,
          trial: { ...trial },
        })),
      ]
      if (refs === undefined || refs.length === 0) {
        const diagnosisRecovery = baseline === undefined ? undefined
          : await this.restoreCandidateDiagnoses(sessionId, baseline, evidence, signal)
        const failedRuns = evidence
          .filter(item => item.roundId === activeRoundId && (
            item.trial.status === 'errored'
            || (item.trial.passStatus !== undefined ? item.trial.passStatus === 'failed'
              : (item.trial.rewards?.reward ?? Object.values(item.trial.rewards ?? {})[0] ?? 0) <= 0)
          ))
          .map(item => ({
            task: item.trial.taskName,
            runId: item.trial.runId,
            status: item.trial.status,
            ...(item.trial.rewards === undefined ? {} : {
              reward: item.trial.rewards.reward ?? Object.values(item.trial.rewards)[0],
            }),
            ...(item.trial.invalidReason === undefined ? {} : { invalidReason: item.trial.invalidReason }),
          }))
        const visibleBaseline = baseline ?? rounds.find(round => round.roundId === activeRoundId)?.baseline
        meta.recordEvidenceAccess(activeRoundId, sessionId, {
          summary: visibleBaseline !== undefined,
          refs: visibleBaseline === undefined ? [] : [
            visibleBaseline.evalId,
            ...visibleBaseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
            ...visibleBaseline.invalidTrials.map(trial => trial.runId),
          ],
        })
        const readiness = baseline === undefined
          ? undefined
          : finalizationReadiness(
              baseline,
              meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
              this.trajectoryBlockers(sessionId, activeRoundId, baseline),
            )
        return publicJson({
          baseline: {
            status: visibleBaseline?.completeness ?? 'unavailable',
            ...(visibleBaseline?.primaryReward === undefined ? {} : { score: visibleBaseline.primaryReward }),
            ...(visibleBaseline?.processScore === undefined ? {} : { processScore: visibleBaseline.processScore }),
            ...(visibleBaseline?.rawMetrics ? { rawMetrics: visibleBaseline.rawMetrics } : {}),
            ...(visibleBaseline?.objectiveScore ? { objectiveScore: visibleBaseline.objectiveScore } : {}),
            ...(visibleBaseline?.summary.passRateStatus ? { passRateStatus: visibleBaseline.summary.passRateStatus, passRate: visibleBaseline.summary.passRate } : {}),
            failedRuns,
          },
          ...(readiness === undefined ? {} : { diagnosisProgress: this.compactDiagnosisProgress(readiness) }),
          ...(diagnosisRecovery === undefined ? {} : { diagnosisRecovery }),
          ...this.generationBudgetStatus(sessionId, rounds.find(value => value.roundId === activeRoundId)),
        })
      }
      if (refs.length > 5) throw new TypeError('trajectory.query accepts at most 5 run refs')
      if (this.options.trajectoryReader === undefined) throw new Error('Hitch trajectory reader is unavailable')
      const selected = this.resolveSeedRefs(refs, evidence, activeRoundId)
      if (selected.length > 5) throw new TypeError('trajectory.query expands to at most 5 runs')
      const cards: MetaFailureCard[] = []
      const receipts: Array<{ item: SeedRunEvidence; receipt: DiagnosisReceipt }> = []
      for (const item of selected) {
        let projection: TrajectoryProjection
        try {
          projection = await this.projectedTrajectory(item.trial.runId, signal)
          const blockerKey = this.trajectoryBlockerKey(sessionId, item.roundId, item.trial.runId)
          const existingBlocker = this.trajectoryEvidenceBlockers.get(blockerKey)
          if (existingBlocker === undefined || !existingBlocker.code.includes('verifier_diagnostic')) {
            this.trajectoryEvidenceBlockers.delete(blockerKey)
          }
        } catch (error) {
          const blocker = this.recordTrajectoryBlocker(sessionId, item.roundId, item.trial.runId, error)
          if (baseline !== undefined) await this.persistTrajectoryQueryBlockers(sessionId, activeRoundId, baseline)
          return publicJson(this.trajectoryEvidenceBlocked([blocker]))
        }
        if (projection.coverage.surface !== 'complete' || projection.fidelity === 'unavailable') {
          const blocker = this.recordTrajectoryBlocker(
            sessionId,
            item.roundId,
            item.trial.runId,
            Object.assign(new Error('bounded trajectory surface is incomplete'), {
              code: 'hitch_trajectory_analysis_incomplete',
            }),
          )
          if (baseline !== undefined) await this.persistTrajectoryQueryBlockers(sessionId, activeRoundId, baseline)
          return publicJson(this.trajectoryEvidenceBlocked([blocker]))
        }
        const prompt = projection.messages.find(message => message.eventType === 'user/message' && message.role === 'user')
        if (prompt === undefined) {
          const blocker = this.recordTrajectoryBlocker(
            sessionId,
            item.roundId,
            item.trial.runId,
            Object.assign(new Error('bounded trajectory has no observable task prompt'), {
              code: 'hitch_trajectory_task_context_missing',
            }),
          )
          if (baseline !== undefined) await this.persistTrajectoryQueryBlockers(sessionId, activeRoundId, baseline)
          return publicJson(this.trajectoryEvidenceBlocked([blocker]))
        }
        const verifier = await this.loadVerifierEvidence(item, signal)
        const card = this.failureCard(
          sessionId,
          item,
          projection,
          verifier,
          roundHeldOutRef(rounds, item.roundId),
        )
        cards.push(card)
        const verifierStatus = verifier.verifier.status === 'missing'
          ? 'explicitly-missing' as const
          : verifier.verifier.status === 'corrupt'
            ? 'unavailable' as const
            : verifier.verifier.status
        const cardDigest = digestJson(card)
        const recovery = {
          sourceDigest: digestJson({ trajectoryDigest: projection.trajectoryDigest, verifier }),
          evidence: { card: this.durableDiagnosticCard({
            ...card,
            // A long assistant reply can push the task out of the recovery transcript tail.
            prompt: this.evidenceText(
              sessionId, item, projection, prompt.message, 160, roundHeldOutRef(rounds, item.roundId),
            ),
          }) },
        }
        if (card.verifier.needsDetail === true && card.verifier.detailRef !== undefined) {
          const requiredDetail = this.trajectoryDetailRefs.get(card.verifier.detailRef)
          if (requiredDetail !== undefined) requiredDetail.pendingDiagnosis = {
            evalId: item.evalId,
            cardDigest,
            trajectoryDigest: projection.trajectoryDigest,
            verifierStatus,
            sourceVerifierStatus: verifier.verifier.status,
            visibleDigests: [],
            recorded: false,
            recovery,
          }
        } else if (projection.coverage.surface === 'complete' && card.transcript.text.length > 0) {
          const receipt = this.diagnosisReceiptForCard(
              card.runId,
              cardDigest,
              projection.trajectoryDigest,
              verifierStatus,
              verifier.verifier.status,
            )
          await this.service.recordCandidateDiagnosis?.(sessionId, { ...recovery, receipt })
          signal.throwIfAborted()
          receipts.push({ item, receipt })
        }
      }
      signal.throwIfAborted()
      for (const { item, receipt } of receipts) meta.recordEvidenceAccess(item.roundId, sessionId, {
        refs: [item.evalId, item.trial.runId], diagnosisReceipts: [receipt],
      })
      for (const { item } of receipts) await this.service.clearMetaPrerequisiteBlocker?.(sessionId, item.trial.runId)
      const readiness = baseline === undefined
        ? undefined
        : finalizationReadiness(
            baseline,
            meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
            this.trajectoryBlockers(sessionId, activeRoundId, baseline),
          )
      return publicJson({
        runs: cards,
        ...(readiness === undefined ? {} : { diagnosisProgress: this.compactDiagnosisProgress(readiness) }),
        ...this.generationBudgetStatus(sessionId, rounds.find(value => value.roundId === activeRoundId)),
      })
    }
    if (method === 'hitch.status') {
      const roundId = this.string(args, 'roundId')
      if (roundId !== activeRoundId) throw new Error('hitch.status is limited to the active round')
      const status = await this.service.status(evolutionId, roundId)
      const visibleStatus = baseline === undefined ? status : {
        ...status,
        seedSummary: baseline.summary,
        seedBaseline: {
          evalId: baseline.evalId,
          completeness: baseline.completeness,
          plannedTrialCount: baseline.plannedTrialCount,
          primaryReward: baseline.primaryReward,
          ...(baseline.rawMetrics ? { rawMetrics: baseline.rawMetrics } : {}),
          ...(baseline.objectiveScore ? { objectiveScore: baseline.objectiveScore } : {}),
          summary: baseline.summary,
          trials: [
            ...baseline.trials.map(trial => ({
              taskName: trial.taskName,
              ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
              ...(trial.runId === undefined ? {} : { runId: trial.runId }),
              ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
              status: trial.status,
              reward: trial.rewards.reward ?? Object.values(trial.rewards)[0],
            })),
            ...baseline.invalidTrials.map(({ originalResult: privateOriginal, ...trial }) => trial),
          ],
        },
      }
      if (visibleStatus.seedBaseline !== undefined) meta.recordEvidenceAccess(roundId, sessionId, {
        summary: true,
        refs: [
          visibleStatus.seedBaseline.evalId,
          ...visibleStatus.seedBaseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
        ],
      })
      return seedOnlyStatus(visibleStatus)
    }
    if (method === 'candidate.diff') {
      return publicJson(await this.service.workspaceManager.diff(workspace.workspaceId, this.optionalInteger(args, 'maxBytes'), signal))
    }
    if (method === 'candidate.check') {
      const check = this.optionalString(args, 'check')
      if (check !== undefined && check !== 'compiler') throw new TypeError('candidate_check only supports the fixed "compiler" pipeline')
      let report: CandidateCheckReport
      let summary
      try {
        summary = await this.service.workspaceManager.preflight(workspace.workspaceId, signal)
        report = await this.service.workspaceManager.withOpenWorkspace(sessionId, true, async handle => this.builder.checkWorkspace(handle, signal))
        summary = await this.service.workspaceManager.preflight(workspace.workspaceId, signal)
      } catch (error) {
        signal.throwIfAborted()
        report = error instanceof CompilerCheckError ? candidateCheckReport(error.report) : {
          ok: false, okScope: 'configured_checks',
          static: { status: 'failed', message: String(error instanceof Error ? error.message : error).slice(-4000) },
          compiler: { ok: false, status: 'not_checked' }, runtime: uncheckedRuntime('', 'STATIC_CHECK_FAILED'),
        }
      }
      const readiness = baseline === undefined
        ? undefined
        : finalizationReadiness(
            baseline,
            meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
            this.trajectoryBlockers(sessionId, activeRoundId, baseline),
          )
      return publicJson(this.sanitize({
        ...report,
        summary,
        compiler: { ...report.compiler, summary },
        ...(readiness === undefined ? {} : { finalizationReadiness: readiness }),
        ...this.generationBudgetStatus(sessionId),
      }, undefined))
    }
    if (method === 'candidate.finalize' || method === 'candidate.decline') {
      const finalization = method === 'candidate.decline' ? null : this.finalization(args)
      const decline = method === 'candidate.decline'
        ? { rationale: this.string(args, 'rationale'), evidenceRefs: this.optionalStrings(args, 'evidenceRefs') ?? [] }
        : undefined
      const citedRefs = finalization?.evidenceRefs ?? decline?.evidenceRefs ?? []
      const evidence = meta.proposalEvidenceAudit(activeRoundId, sessionId, citedRefs)
      if (baseline !== undefined) {
        const readiness = finalizationReadiness(
          baseline,
          evidence,
          this.trajectoryBlockers(sessionId, activeRoundId, baseline),
        )
        const recovery = recoveryRequired(
          readiness,
          method === 'candidate.decline' ? 'candidate.decline' : 'candidate.finalize',
        )
        if (recovery !== undefined) {
          if (!recovery.recoverable) {
            await this.service.recordMetaPrerequisiteBlocker?.(sessionId, this.metaPrerequisiteFailure(recovery))
          }
          return publicJson(recovery)
        }
      }
      await this.service.clearMetaPrerequisiteBlocker?.(sessionId)
      const attribution = await meta.proposalAttribution(activeRoundId, sessionId, finalization)
      const diff = await this.service.submitFinalization(evolutionId, activeRoundId, finalization, decline, attribution, evidence)
      return publicJson({ accepted: true, evolutionId, roundId: activeRoundId, ...(diff === undefined ? {} : { diff }) })
    }
    throw new Error(`unknown refine-meta capability: ${method}`)
  }

  private durableDiagnosticCard(card: MetaFailureCard): MetaFailureCard {
    // These capabilities belong to the old session. Reissue a current-session
    // archive ref on restoration; deeper trajectory reads can query the run.
    return JSON.parse(JSON.stringify(card, (key, value) => {
      if (['detailRef', 'earlierRef', 'needsDetail'].includes(key)) return undefined
      return typeof value === 'string' ? value.replace(/\[more: detail_[a-f0-9]+\]/gu, '[query this run for full detail]') : value
    })) as MetaFailureCard
  }

  private sanitizationPolicyDigest(): string {
    return digestJson({ sensitiveKeyPattern: PUBLIC_SENSITIVE_KEY.source,
      secretDigests: this.secretValues.map(value => digestJson(value)).sort() })
  }

  private async restoreCandidateDiagnoses(
    sessionId: string, baseline: EvaluationEvidence, runs: SeedRunEvidence[], signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const records = await this.service.readCandidateDiagnoses?.(sessionId) ?? []
    const active = this.service.activeEntryForSession(sessionId)
    if (active === undefined) throw new Error('stale candidate diagnosis owner')
    const audit = active.meta.proposalEvidenceAudit(active.roundId, sessionId, [])
    const diagnosed = new Set((audit.diagnosisReceipts ?? []).filter(receiptIsValid).map(value => value.runId))
    const latest = new Map(records.map(value => [value.receipt.runId, value]))
    const pending = [...latest.values()].filter(value => !diagnosed.has(value.receipt.runId))
    if (pending.length === 0) return undefined
    const restored: Array<Record<string, unknown>> = []
    const restoredReceipts: DiagnosisReceipt[] = []
    const invalidatedRunIds: string[] = []
    let bytes = 0
    let remaining = 0
    for (const record of pending) {
      signal.throwIfAborted()
      const runId = record.receipt.runId
      const item = runs.find(value => value.trial.runId === runId && value.evalId === baseline.evalId)
      if (item === undefined || !receiptIsValid(record.receipt)
        || record.receipt.sanitizationPolicyDigest !== this.sanitizationPolicyDigest()
        || record.receipt.compatibility !== undefined && this.options.allowUnavailableVerifierDiagnosis !== true) {
        invalidatedRunIds.push(runId); continue
      }
      const row = {
        runId, task: boundedUtf8(record.evidence.card.task, 256), outcome: record.evidence.card.outcome,
        prompt: boundedUtf8(record.evidence.card.prompt?.text ?? '', 160),
        verifier: boundedUtf8(record.evidence.verifierDetails ?? JSON.stringify(record.evidence.card.verifier), 400),
        transcriptTail: boundedUtf8(record.evidence.card.transcript.text.slice(-240), 240),
        sourceAttempt: record.source.attempt,
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 128
      if (bytes + rowBytes > Math.max(4096, Math.min(64 * 1024, this.maxReadBytes))) { remaining += 1; continue }
      // Verify live evidence without asking the model to diagnose it again.
      // Bypass the projection cache: the same run ID may have been repaired.
      try {
        const projection = projectTrajectory(await this.requireTrajectoryReader().inspectTrajectoryAnalysis(runId, signal))
        const verifier = await this.loadVerifierEvidence(item, signal)
        if (projection.coverage.surface !== 'complete' || projection.fidelity === 'unavailable'
          || digestJson({ trajectoryDigest: projection.trajectoryDigest, verifier }) !== record.sourceDigest) {
          this.deleteTrajectoryProjection(runId)
          invalidatedRunIds.push(runId); continue
        }
      } catch (error) {
        signal.throwIfAborted()
        this.deleteTrajectoryProjection(runId)
        invalidatedRunIds.push(runId); continue
      }
      signal.throwIfAborted()
      if (this.service.activeEntryForSession(sessionId) === undefined) throw new Error('stale candidate diagnosis owner')
      const detailRef = this.inlineDetailRef(sessionId, active.roundId, runId, JSON.stringify(record.evidence))
      restored.push({ ...row, detailRef })
      bytes += rowBytes
      restoredReceipts.push(record.receipt)
    }
    signal.throwIfAborted()
    active.meta.recordEvidenceAccess(active.roundId, sessionId, {
      refs: [baseline.evalId, ...restoredReceipts.map(value => value.runId)], diagnosisReceipts: restoredReceipts,
    })
    return { restored, invalidatedRunIds, remaining,
      ...(remaining === 0 ? {} : { nextAction: 'Query trajectory.query without arguments to receive the remaining recovery summaries.' }),
      workspace: 'Edits are not restored by diagnostic recovery; inspect the current candidate tree.',
    }
  }

  private generationBudgetStatus(sessionId: string, round?: RefinementRound): Record<string, unknown> {
    const active = this.service.activeEntryForSession(sessionId)
    const budget = active?.generationBudget
    if (active === undefined || budget === undefined) return {}
    const audit = active.meta.proposalEvidenceAudit(active.roundId, sessionId, [])
    const readiness = finalizationReadiness(active.baseline, audit)
    const attempt = round?.candidatePool.find(value => value.candidateId === active.candidateId)
      ?.generationAttempts?.find(value => value.attempt === budget.attempt)
    const began = Date.parse(attempt?.preparationCompletedAt ?? '')
    const currentReads = (audit.diagnosisReceipts ?? []).filter(value => receiptIsValid(value) && Date.parse(value.inspectedAt) >= began)
    const lastRead = Math.max(...currentReads.map(value => Date.parse(value.inspectedAt)))
    const estimate = readiness.remainingRunCount === 0 ? 0 : currentReads.length === 0 ? undefined
      : Math.ceil(Math.max(0, lastRead - began) / currentReads.length * readiness.remainingRunCount)
    return { generationBudget: { ...budget,
      diagnosedRunCount: readiness.diagnosedRunCount, remainingRunCount: readiness.remainingRunCount,
      estimatedDiagnosisRemainingMs: estimate ?? null,
      ...(readiness.remainingRunCount > 0 && (budget.diagnosisAvailableMs === 0
        || estimate !== undefined && estimate > budget.diagnosisAvailableMs) ? {
          warning: 'DIAGNOSIS_BUDGET_AT_RISK',
          message: 'Remaining diagnosis may consume the time reserved for editing and validation. Deadlines do not reset on reconnect. A larger budget requires a new evolution.',
        } : {}),
    } }
  }

  private async queryExperience(
    sessionId: string,
    store: RefineStateStore,
    round: RefinementRound,
    parentHarnessRef: string | undefined,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const snapshot = round.experienceSnapshot!
    let query: SeedExperienceQuery
    let queryDigest: string
    let offset = 0
    let limit: number
    const cursorRef = this.optionalString(args, 'cursor')
    if (cursorRef !== undefined) {
      assertOnlyKeys(args, ['cursor'])
      const cursor = this.experienceQueryCursors.get(cursorRef)
      if (cursor === undefined || cursor.sessionId !== sessionId || cursor.roundId !== round.roundId
        || cursor.snapshotDigest !== snapshot.digest) {
        throw new Error('experience cursor is unknown or no longer valid for this Meta task')
      }
      query = structuredClone(cursor.query)
      queryDigest = cursor.queryDigest
      offset = cursor.offset
      limit = cursor.limit
    } else {
      assertOnlyKeys(args, ['query', 'taskNames', 'semanticTargets', 'paths', 'effects', 'limit', 'cursor'])
      const text = this.optionalString(args, 'query')
      if (text !== undefined && Buffer.byteLength(text) > 1_000) throw new TypeError('experience query is limited to 1000 bytes')
      const taskNames = this.optionalStrings(args, 'taskNames')
      const semanticTargets = this.optionalStrings(args, 'semanticTargets')
      const paths = this.optionalStrings(args, 'paths')
      const effects = this.optionalStrings(args, 'effects')
      for (const [name, values, maxLength] of [
        ['taskNames', taskNames, 240], ['semanticTargets', semanticTargets, 32],
        ['paths', paths, 500], ['effects', effects, 32],
      ] as const) {
        if ((values?.length ?? 0) > 20 || values?.some(value => value.length > maxLength)) {
          throw new TypeError(`${name} accepts at most 20 bounded values`)
        }
      }
      const allowedTargets = new Set<SemanticTarget>([
        'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
        'skill', 'tool', 'workflow', 'compaction',
      ])
      if (semanticTargets?.some(value => !allowedTargets.has(value as SemanticTarget))) {
        throw new TypeError('semanticTargets contains an unknown target')
      }
      const allowedEffects = new Set<SeedExperienceEffect>([
        'improved', 'regressed', 'mixed', 'unchanged', 'insufficient',
      ])
      if (effects?.some(value => !allowedEffects.has(value as SeedExperienceEffect))) {
        throw new TypeError('effects contains an unknown seed outcome')
      }
      if (paths?.some(path => path.startsWith('/') || path.includes('\\')
        || path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..'))) {
        throw new TypeError('paths must contain normalized relative harness paths')
      }
      query = {
        ...(text === undefined ? {} : { query: text }),
        ...(taskNames === undefined ? {} : { taskNames: [...new Set(taskNames)].sort() }),
        ...(semanticTargets === undefined ? {} : {
          semanticTargets: [...new Set(semanticTargets)].sort() as SemanticTarget[],
        }),
        ...(paths === undefined ? {} : { paths: [...new Set(paths)].sort() }),
        ...(effects === undefined ? {} : {
          effects: [...new Set(effects)].sort() as SeedExperienceEffect[],
        }),
      }
      const requestedLimit = this.optionalInteger(args, 'limit') ?? 5
      if (requestedLimit < 1 || requestedLimit > EXPERIENCE_V1_MAX_QUERY_RESULTS) {
        throw new TypeError(`experience query limit must be between 1 and ${EXPERIENCE_V1_MAX_QUERY_RESULTS}`)
      }
      limit = requestedLimit
      queryDigest = digestJson({ snapshotDigest: snapshot.digest, query })
    }

    const loaded = await loadSeedExperienceSnapshot(store, snapshot)
    if (loaded.unavailableRecordIds.length > 0) {
      throw new Error(`seed experience snapshot is incomplete; unavailable record IDs: ${loaded.unavailableRecordIds.join(', ')}`)
    }
    const ranked = rankSeedExperience(loaded.records, query, parentHarnessRef)
    const results: Array<Record<string, unknown>> = []
    let nextOffset = offset
    for (const item of ranked.slice(offset, offset + limit)) {
      const card = renderSeedExperienceCard(item.record, item.matchReasons)
      const result = {
        ...card,
        markdown: this.experienceText(card.markdown, round.heldOutRef, EXPERIENCE_V1_MAX_CARD_BYTES),
        matchReasons: card.matchReasons.map(reason => this.experienceText(reason, round.heldOutRef, 300)),
        recordDigest: item.record.recordDigest,
        seedProjectionDigest: item.record.seedProjectionDigest,
        relevanceScore: item.score,
      }
      const trial = {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        queryDigest,
        results: [...results, result],
      }
      if (this.experienceResponseBytes(trial, round.heldOutRef) > EXPERIENCE_V1_MAX_QUERY_BYTES - 256) break
      results.push(result)
      nextOffset += 1
    }
    let nextCursor: string | undefined
    if (nextOffset < ranked.length) {
      nextCursor = `experience_cursor_${randomBytes(16).toString('hex')}`
      this.experienceQueryCursors.set(nextCursor, {
        sessionId,
        roundId: round.roundId,
        snapshotDigest: snapshot.digest,
        queryDigest,
        query: structuredClone(query),
        offset: nextOffset,
        limit,
      })
      while (this.experienceQueryCursors.size > 4_096) {
        const oldest = this.experienceQueryCursors.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.experienceQueryCursors.delete(oldest)
      }
    }
    const response = {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      queryDigest,
      results,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
    return response
  }

  private async readExperience(
    sessionId: string,
    store: RefineStateStore,
    round: RefinementRound,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    assertOnlyKeys(args, ['ref', 'view', 'offset', 'limit', 'runId', 'detailRef', 'find'])
    const ref = this.string(args, 'ref')
    const view = this.string(args, 'view')
    if (!['record', 'card', 'task-results', 'diff', 'trajectory'].includes(view)) {
      throw new TypeError('experience read view must be record, card, task-results, diff, or trajectory')
    }
    const digest = experienceDigestFromRef(ref)
    const snapshot = round.experienceSnapshot!
    const member = digest === undefined ? undefined : snapshot.members.find(item => item.recordDigest === digest)
    if (member === undefined) throw new Error('experience ref is not authorized by the active round snapshot')
    let experience: SeedExperienceRecord | undefined
    try {
      experience = await store.readExperienceRecord(member.recordDigest)
    } catch {
      experience = undefined
    }
    if (experience === undefined || experience.recordId !== member.recordId
      || experience.source.evolutionId !== round.evolutionId
      || experience.source.roundId !== member.sourceRoundId
      || experience.source.candidateId !== member.candidateId
      || experience.source.candidateHarnessRef !== member.candidateHarnessRef) {
      return {
        schemaVersion: 1,
        available: false,
        snapshotDigest: snapshot.digest,
        ref,
        reason: 'The exact seed experience revision sealed into this round is unavailable.',
      }
    }
    const base = {
      schemaVersion: 1,
      available: true,
      snapshotDigest: snapshot.digest,
      ref,
      recordId: experience.recordId,
      recordDigest: experience.recordDigest,
      seedProjectionDigest: experience.seedProjectionDigest,
      view,
    }
    if (view === 'card') {
      const card = renderSeedExperienceCard(experience)
      return {
        ...base,
        card: {
          ...card,
          markdown: this.experienceText(card.markdown, round.heldOutRef, EXPERIENCE_V1_MAX_CARD_BYTES),
        },
      }
    }

    const offset = this.optionalInteger(args, 'offset') ?? 0
    const limit = this.optionalInteger(args, 'limit') ?? 20
    if (limit < 1 || limit > EXPERIENCE_V1_MAX_READ_ITEMS) {
      throw new TypeError(`experience read limit must be between 1 and ${EXPERIENCE_V1_MAX_READ_ITEMS}`)
    }
    if (view === 'record') {
      const files = experience.change.files.map(file => ({
        ...file,
        path: this.experienceText(file.path, round.heldOutRef, 500),
      }))
      const rationale = this.experienceText(experience.proposal.rationale, round.heldOutRef, 8 * 1024)
      const expectedOutcome = this.experienceText(experience.proposal.expectedOutcome, round.heldOutRef, 8 * 1024)
      const response = (visibleFiles: readonly unknown[], nextOffset?: number) => ({
        ...base,
        record: {
          schemaVersion: experience.schemaVersion,
          source: experience.source,
          applicability: experience.applicability,
          proposal: {
            rationale,
            expectedOutcome,
            semanticTargets: experience.proposal.semanticTargets,
            ...(rationale !== experience.proposal.rationale || expectedOutcome !== experience.proposal.expectedOutcome
              ? { claimsTruncated: true }
              : {}),
          },
          change: {
            patchDigest: experience.change.patchDigest,
            totalBytes: experience.change.totalBytes,
            files: visibleFiles,
          },
          observation: {
            comparison: experience.observation.comparison,
            planned: experience.observation.planned,
            valid: experience.observation.valid,
            excluded: experience.observation.excluded,
            baselineInvalid: experience.observation.baselineInvalid,
            candidateInvalid: experience.observation.candidateInvalid,
            ...(experience.observation.baselineMean === undefined ? {} : {
              baselineMean: experience.observation.baselineMean,
              candidateMean: experience.observation.candidateMean,
              meanRewardDelta: experience.observation.meanRewardDelta,
            }),
            ...(experience.observation.modificationUse === undefined ? {} : {
              modificationUse: {
                ...experience.observation.modificationUse,
                artifacts: experience.observation.modificationUse.artifacts
                  .slice(offset, offset + visibleFiles.length)
                  .map(artifact => ({
                    ...artifact,
                    path: this.experienceText(artifact.path, round.heldOutRef, 500),
                  })),
              },
            }),
          },
          classification: experience.classification,
        },
        offset,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      })
      const visibleFiles: unknown[] = []
      let index = offset
      while (index < files.length && visibleFiles.length < limit) {
        const nextFiles = [...visibleFiles, files[index]]
        const nextOffset = index + 1 < files.length ? index + 1 : undefined
        if (this.experienceResponseBytes(response(nextFiles, nextOffset), round.heldOutRef)
          > EXPERIENCE_V1_MAX_READ_BYTES - 256) break
        visibleFiles.push(files[index])
        index += 1
      }
      if (index < files.length && visibleFiles.length === 0) {
        throw new Error('one seed experience record file exceeds the fixed response limit')
      }
      return response(visibleFiles, index < files.length ? index : undefined)
    }
    if (view === 'task-results') {
      const items = [
        ...experience.observation.taskResults,
        ...experience.observation.excludedTaskResults,
      ].sort((left, right) => left.trialKey.localeCompare(right.trialKey)).map(item => this.publicExperienceTask(item, round.heldOutRef))
      const pageBase = {
        ...base,
        coverage: {
          planned: experience.observation.planned,
          valid: experience.observation.valid,
          excluded: experience.observation.excluded,
        },
        ...(experience.observation.modificationUse === undefined ? {} : {
          modificationUse: {
            schemaVersion: experience.observation.modificationUse.schemaVersion,
            extractorVersion: experience.observation.modificationUse.extractorVersion,
            candidateTrials: experience.observation.modificationUse.candidateTrials,
            statusCounts: experience.observation.modificationUse.statusCounts,
            validPairStatusCounts: experience.observation.modificationUse.validPairStatusCounts,
            conditionedResults: experience.observation.modificationUse.conditionedResults,
          },
        }),
        offset,
      }
      const page = this.experiencePage(pageBase, items, offset, limit)
      return {
        ...pageBase,
        results: page.items,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      }
    }
    if (view === 'diff') {
      const selectedFiles = experience.change.files.slice(offset, offset + limit)
      if (selectedFiles.length === 0) throw new TypeError('experience diff offset is outside the changed-file list')
      const visibleFiles = selectedFiles.map(file => ({
        ...file,
        path: this.experienceText(file.path, round.heldOutRef, 500),
      }))
      const nextOffset = offset + selectedFiles.length < experience.change.files.length
        ? offset + selectedFiles.length
        : undefined
      try {
        const diff = await this.builder.readHarnessDiff(
          experience.source.parentHarnessRef,
          experience.source.candidateHarnessRef,
          selectedFiles.map(file => file.path),
          EXPERIENCE_V1_MAX_READ_BYTES,
          signal,
        )
        const safePatch = this.sanitize(diff.patch, round.heldOutRef) as string
        const responseForPatch = (patch: string): Record<string, unknown> => ({
          ...base,
          change: {
            patchDigest: experience.change.patchDigest,
            totalBytes: experience.change.totalBytes,
            fileCount: experience.change.files.length,
            files: visibleFiles,
          },
          offset,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          diff: {
            parentRef: diff.parentRef,
            candidateRef: diff.candidateRef,
            paths: visibleFiles.map(file => file.path),
            patch,
            patchBytes: diff.patchBytes,
            contentDigest: diff.contentDigest,
            truncated: diff.truncated || patch !== safePatch,
          },
        })
        const complete = responseForPatch(safePatch)
        if (this.experienceResponseBytes(complete, round.heldOutRef) <= EXPERIENCE_V1_MAX_READ_BYTES) return complete

        let low = 0
        let high = Buffer.byteLength(safePatch)
        let visiblePatch = ''
        while (low <= high) {
          const middle = Math.floor((low + high) / 2)
          const candidatePatch = middle === 0 ? '' : boundedUtf8(safePatch, middle)
          if (this.experienceResponseBytes(responseForPatch(candidatePatch), round.heldOutRef) <= EXPERIENCE_V1_MAX_READ_BYTES) {
            visiblePatch = candidatePatch
            low = middle + 1
          } else {
            high = middle - 1
          }
        }
        return responseForPatch(visiblePatch)
      } catch {
        signal.throwIfAborted()
        return {
          ...base,
          available: false,
          reason: 'The verified candidate/parent Git objects for this historical diff are unavailable.',
        }
      }
    }
    return this.readExperienceTrajectory(sessionId, round, experience, base, args, signal)
  }

  private experiencePage(
    base: Record<string, unknown>,
    items: readonly unknown[],
    offset: number,
    limit: number,
  ): { items: unknown[]; nextOffset?: number } {
    const visible: unknown[] = []
    let index = offset
    while (index < items.length && visible.length < limit) {
      const next = [...visible, items[index]]
      if (Buffer.byteLength(JSON.stringify({ ...base, results: next })) > EXPERIENCE_V1_MAX_READ_BYTES - 512) {
        if (visible.length === 0) throw new Error('one seed experience item exceeds the fixed response limit')
        break
      }
      visible.push(items[index])
      index += 1
    }
    return { items: visible, ...(index < items.length ? { nextOffset: index } : {}) }
  }

  private publicExperienceTask(
    item: SeedExperienceRecord['observation']['taskResults'][number]
      | SeedExperienceRecord['observation']['excludedTaskResults'][number],
    heldOutRef: string,
  ): Record<string, unknown> {
    const side = (value: typeof item.baseline): Record<string, unknown> => {
      const modificationUse = value.modificationUse
      const prioritizedArtifacts = modificationUse === undefined
        ? []
        : [...modificationUse.artifacts].sort((left, right) => {
            const priority = { observed: 0, 'attempted-failure': 1, unknown: 2, 'not-observed': 3 }
            return priority[left.status] - priority[right.status] || left.path.localeCompare(right.path)
          })
      let actionExamples = 8
      const visibleArtifacts = prioritizedArtifacts.slice(0, 12).map(artifact => {
        const actions = artifact.actions.slice(0, actionExamples)
        actionExamples -= actions.length
        return {
          ...artifact,
          path: this.experienceText(artifact.path, heldOutRef, 500),
          actions: actions.map(action => ({
            ...action,
            sessionId: boundedUtf8(action.sessionId, 200),
            sourcePath: this.experienceText(action.sourcePath, heldOutRef, 500),
            ...(action.callId === undefined ? {} : { callId: boundedUtf8(action.callId, 300) }),
            ...(action.toolName === undefined ? {} : { toolName: boundedUtf8(action.toolName, 100) }),
          })),
          ...((artifact.observedActionCount + artifact.failedActionCount) <= actions.length ? {} : {
            actionExamplesOmitted: artifact.observedActionCount + artifact.failedActionCount - actions.length,
          }),
        }
      })
      return {
        status: value.status,
        ...(value.trialName === undefined ? {} : { trialName: this.experienceText(value.trialName, heldOutRef, 300) }),
        ...(value.runId === undefined ? {} : { runId: boundedUtf8(value.runId, 160) }),
        ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
        ...(value.reward === undefined ? {} : { reward: value.reward }),
        ...(modificationUse === undefined ? {} : {
          modificationUse: {
            ...modificationUse,
            artifactCount: modificationUse.artifacts.length,
            artifacts: visibleArtifacts,
            ...(prioritizedArtifacts.length <= visibleArtifacts.length ? {} : {
              artifactsOmitted: prioritizedArtifacts.length - visibleArtifacts.length,
            }),
          },
        }),
      }
    }
    return {
      valid: item.valid,
      trialKey: boundedUtf8(item.trialKey, 600),
      taskName: this.experienceText(item.taskName, heldOutRef, 300),
      ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
      baseline: side(item.baseline),
      candidate: side(item.candidate),
      ...(item.valid ? { rewardDelta: item.rewardDelta } : { reasons: item.reasons }),
    }
  }

  private async readExperienceTrajectory(
    sessionId: string,
    round: RefinementRound,
    experience: SeedExperienceRecord,
    base: Record<string, unknown>,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const detailRef = this.optionalString(args, 'detailRef')
    const find = this.optionalString(args, 'find')
    if (detailRef !== undefined) {
      const detail = this.trajectoryDetailRefs.get(detailRef)
      const allowedRuns = this.experienceRunIds(experience)
      if (detail === undefined || detail.sessionId !== sessionId || detail.roundId !== experience.source.roundId
        || !allowedRuns.has(detail.runId)) {
        throw new Error('experience trajectory detailRef is unknown or not authorized by this record')
      }
      const read = await this.readTrajectoryDetail(
        sessionId,
        experience.source.roundId,
        detailRef,
        find,
        round.heldOutRef,
        signal,
      )
      // Historical reads deliberately do not record current-round diagnosis receipts.
      return { ...base, runId: detail.runId, ...read.visible }
    }
    if (find !== undefined) throw new TypeError('find requires detailRef')
    const runId = this.string(args, 'runId')
    const item = this.experienceRunEvidence(experience, runId)
    if (item === undefined) throw new Error('runId is not authorized by this seed experience record')
    try {
      const projection = await this.projectedTrajectory(runId, signal)
      if (projection.runId !== runId || projection.coverage.surface !== 'complete' || projection.fidelity === 'unavailable') {
        return {
          ...base,
          available: false,
          runId,
          reason: 'The bounded historical seed trajectory is incomplete or has an identity mismatch.',
        }
      }
      const verifier = await this.loadVerifierEvidence(item, signal)
      const card = this.failureCard(sessionId, item, projection, verifier, round.heldOutRef, 8 * 1024, 'bytes')
      return {
        ...base,
        runId,
        trajectoryDigest: projection.trajectoryDigest,
        projectionVersion: 1,
        card,
      }
    } catch {
      signal.throwIfAborted()
      return {
        ...base,
        available: false,
        runId,
        reason: 'The exact bounded trajectory for this recorded seed run is unavailable.',
      }
    }
  }

  private experienceRunIds(experience: SeedExperienceRecord): Set<string> {
    return new Set([
      ...experience.observation.taskResults,
      ...experience.observation.excludedTaskResults,
    ].flatMap(item => [item.baseline.runId, item.candidate.runId]
      .filter((runId): runId is string => runId !== undefined)))
  }

  private experienceRunEvidence(experience: SeedExperienceRecord, runId: string): SeedRunEvidence | undefined {
    for (const result of [
      ...experience.observation.taskResults,
      ...experience.observation.excludedTaskResults,
    ]) {
      for (const side of ['baseline', 'candidate'] as const) {
        const trial = result[side]
        if (trial.runId !== runId) continue
        const invalidReason = result.valid ? undefined : result.reasons.join(', ')
        return {
          evolutionId: experience.source.evolutionId,
          roundId: experience.source.roundId,
          phase: side === 'baseline' ? 'seed-baseline' : 'seed-candidate',
          evalId: side === 'baseline' ? experience.source.parentBaselineEvalId : experience.source.candidateEvalId,
          trial: {
            taskName: result.taskName,
            ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
            runId,
            ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
            status: trial.status === 'missing' ? 'errored' : trial.status,
            ...(trial.reward === undefined ? {} : { rewards: { reward: trial.reward } }),
            ...(invalidReason === undefined ? {} : { invalidReason }),
          },
        }
      }
    }
    return undefined
  }

  private experienceText(value: string, heldOutRef: string, maxBytes: number): string {
    return boundedUtf8(this.sanitize(value, heldOutRef) as string, maxBytes)
  }

  private experienceResponseBytes(value: unknown, heldOutRef: string): number {
    return Buffer.byteLength(JSON.stringify(publicJson(this.sanitize(value, heldOutRef))))
  }

  private experienceResponse(value: unknown, heldOutRef: string, maxBytes: number): JsonValue {
    const response = publicJson(this.sanitize(value, heldOutRef))
    if (Buffer.byteLength(JSON.stringify(response)) > maxBytes) {
      throw new Error(`bounded seed experience response exceeded its fixed ${maxBytes}-byte limit`)
    }
    return response
  }

  private async projectedTrajectory(
    runId: string,
    signal: AbortSignal,
  ): Promise<TrajectoryProjection> {
    const cached = this.trajectoryProjections.get(runId)
    if (cached !== undefined) {
      this.trajectoryProjections.delete(runId)
      this.trajectoryProjections.set(runId, cached)
      return this.waitForProjection(runId, cached, signal)
    }
    const controller = new AbortController()
    const shared: SharedProjectionLoad = {
      promise: this.requireTrajectoryReader().inspectTrajectoryAnalysis(runId, controller.signal).then(projectTrajectory),
      controller,
      waiters: 0,
      settled: false,
      bytes: 0,
    }
    this.trajectoryProjections.set(runId, shared)
    void shared.promise.then(
      projection => {
        shared.settled = true
        if (this.trajectoryProjections.get(runId) === shared) {
          shared.bytes = Buffer.byteLength(JSON.stringify(projection))
          this.trajectoryProjectionCacheBytes += shared.bytes
          this.trimTrajectoryProjectionCache()
        }
      },
      () => {
        shared.settled = true
        this.deleteTrajectoryProjection(runId, shared)
      },
    )
    this.trimTrajectoryProjectionCache()
    return this.waitForProjection(runId, shared, signal)
  }

  private trimTrajectoryProjectionCache(): void {
    const maxEntries = this.options.maxTrajectoryCacheEntries ?? 8
    const maxBytes = this.options.maxTrajectoryProjectionCacheBytes ?? 64 * 1024 * 1024
    while (this.trajectoryProjections.size > maxEntries || this.trajectoryProjectionCacheBytes > maxBytes) {
      const oldest = this.trajectoryProjections.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.deleteTrajectoryProjection(oldest)
    }
  }

  private deleteTrajectoryProjection(runId: string, expected?: SharedProjectionLoad): void {
    const existing = this.trajectoryProjections.get(runId)
    if (existing === undefined || (expected !== undefined && existing !== expected)) return
    this.trajectoryProjections.delete(runId)
    this.trajectoryProjectionCacheBytes = Math.max(0, this.trajectoryProjectionCacheBytes - existing.bytes)
  }

  private waitForProjection(
    runId: string,
    shared: SharedProjectionLoad,
    signal: AbortSignal,
  ): Promise<TrajectoryProjection> {
    signal.throwIfAborted()
    shared.waiters += 1
    return new Promise((resolvePromise, reject) => {
      let completed = false
      const release = (): void => {
        if (completed) return
        completed = true
        signal.removeEventListener('abort', abort)
        shared.waiters -= 1
        if (shared.waiters === 0 && !shared.settled) {
          shared.controller.abort(new Error(`trajectory projection abandoned for ${runId}`))
        }
      }
      const abort = (): void => {
        release()
        reject(signal.reason ?? new Error('trajectory projection aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void shared.promise.then(
        value => { release(); resolvePromise(value) },
        error => { release(); reject(error) },
      )
    })
  }

  private requireTrajectoryReader(): HitchTrajectoryReader {
    const reader = this.options.trajectoryReader
    if (reader === undefined) throw new Error('Hitch bounded trajectory reader is unavailable')
    return reader
  }

  private trajectoryBlockerKey(sessionId: string, roundId: string, runId: string): string {
    return `${sessionId}\0${roundId}\0${runId}`
  }

  private recordTrajectoryBlocker(
    sessionId: string,
    roundId: string,
    runId: string,
    error: unknown,
  ): TrajectoryEvidenceBlocker {
    const source = error as { code?: unknown; cause?: unknown; resolution?: unknown }
    const code = typeof source?.code === 'string' && /^[a-z0-9_]{1,128}$/u.test(source.code)
      ? source.code
      : 'hitch_trajectory_project_failed'
    const resolution: TrajectoryEvidenceBlocker['resolution'] = source?.resolution === 'upgrade-hitch'
      || source?.resolution === 'repair-evidence'
      ? source.resolution
      : code === 'hitch_trajectory_capabilities_unavailable'
        || code === 'hitch_verifier_diagnostic_pages_unavailable'
        ? 'upgrade-hitch'
        : 'repair-evidence'
    const cause = typeof source?.cause === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(source.cause)
      ? source.cause
      : code
    const blocker = {
      runId,
      code,
      message: `Bounded trajectory evidence could not be constructed for ${runId} (${code}).`,
      resolution,
      cause,
    }
    this.trajectoryEvidenceBlockers.set(this.trajectoryBlockerKey(sessionId, roundId, runId), blocker)
    return blocker
  }

  private trajectoryBlockers(
    sessionId: string,
    roundId: string,
    baseline: EvaluationEvidence,
  ): TrajectoryEvidenceBlocker[] {
    const required = new Set([
      ...baseline.trials.filter(trial => trial.passStatus !== undefined ? trial.passStatus === 'failed' : (trial.rewards.reward ?? Object.values(trial.rewards)[0] ?? 0) <= 0)
        .flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
    ])
    return [...required].flatMap(runId => {
      const blocker = this.trajectoryEvidenceBlockers.get(this.trajectoryBlockerKey(sessionId, roundId, runId))
      return blocker === undefined ? [] : [blocker]
    }).sort((left, right) => left.runId.localeCompare(right.runId))
  }

  private trajectoryEvidenceBlocked(blockers: readonly TrajectoryEvidenceBlocker[]): Record<string, unknown> {
    const requiresUpgrade = blockers.some(item => item.resolution === 'upgrade-hitch')
    const requiresRepair = blockers.some(item => item.resolution !== 'upgrade-hitch')
    return {
      schemaVersion: 1,
      runs: [],
      batchAccepted: false,
      recoverable: false,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      message: `Diagnostic cards could not be constructed for ${blockers.length} run${blockers.length === 1 ? '' : 's'}. Resolve the reported prerequisite before retrying.`,
      blockedRuns: blockers,
      operatorAction: {
        ...(requiresUpgrade ? { upgrade: 'Upgrade Hitch to provide bounded verifier diagnostic pages.' } : {}),
        ...(requiresRepair ? { repair: 'Repair or re-import the persisted trajectory or verifier evidence for the affected runs.' } : {}),
        runIds: blockers.map(item => item.runId),
        reason: blockers.map(item => item.cause ?? item.code).join(','),
      },
    }
  }

  private async loadVerifierEvidence(
    item: SeedRunEvidence,
    signal: AbortSignal,
  ): Promise<HitchVerifierEvidence> {
    try {
      const inspect = this.options.trajectoryReader?.inspectVerifierEvidence
      if (inspect === undefined) return { runId: item.trial.runId, verifier: { status: 'unavailable' } }
      const evidence = await inspect.call(this.options.trajectoryReader, item.trial.runId, signal)
      if (evidence.runId !== item.trial.runId) {
        throw new Error(`verifier evidence run identity mismatch for ${item.trial.runId}`)
      }
      if (evidence.parent !== undefined) {
        const resolveRun = this.options.trajectoryReader?.resolveVerifierRun
        const physical = await resolveRun?.call(this.options.trajectoryReader, item.evalId, item.trial.runId, signal)
        const resolveParent = this.options.trajectoryReader?.resolveVerifierEvaluationId
        const expectedEvalId = physical?.evalId ?? (resolveParent === undefined ? item.evalId
          : await resolveParent.call(this.options.trajectoryReader, item.evalId, item.trial.runId, signal))
        const expectedTrial = physical ?? item.trial
        if (typeof expectedEvalId !== 'string' || expectedEvalId.length === 0
          || evidence.parent.evalId !== expectedEvalId) {
          throw new Error(`verifier evidence eval identity mismatch for ${item.trial.runId}`)
        }
        if (expectedTrial.trialName !== undefined && evidence.parent.trialId !== expectedTrial.trialName) {
          throw new Error(`verifier evidence trial identity mismatch for ${item.trial.runId}`)
        }
        if (expectedTrial.attempt !== undefined && evidence.parent.attempt !== expectedTrial.attempt) {
          throw new Error(`verifier evidence attempt identity mismatch for ${item.trial.runId}`)
        }
      }
      return evidence
    } catch (error) {
      signal.throwIfAborted()
      const source = error as { code?: unknown; message?: unknown }
      const code = typeof source?.code === 'string' && /^[a-z0-9_]{1,128}$/u.test(source.code)
        ? source.code
        : 'hitch_verifier_evidence_invalid'
      const detail = typeof source?.message === 'string' ? source.message : String(error)
      return {
        runId: item.trial.runId,
        verifier: {
          status: 'corrupt',
          issues: [`Verifier evidence could not be validated (${code}): ${boundedUtf8(detail, 512)}`],
        },
      }
    }
  }

  private compactDiagnosisProgress(value: ReturnType<typeof finalizationReadiness>): Record<string, unknown> {
    return {
      ready: value.ready,
      diagnosed: value.diagnosedRunCount,
      required: value.failedRunCount,
      remainingRunIds: value.missing.map(item => item.runId),
    }
  }

  private metaPrerequisiteFailure(value: MetaPrerequisiteBlocked): MetaPrerequisiteFailure {
    const blockedRuns = value.code === 'TRAJECTORY_EVIDENCE_UNAVAILABLE'
      ? value.readiness.trajectoryBlockedRuns.map(item => ({
          runId: item.runId,
          code: item.code,
          ...(item.cause === undefined ? {} : { cause: item.cause }),
          ...(item.resolution === undefined ? {} : { resolution: item.resolution }),
        }))
      : value.readiness.verifierBlockedRunIds.map(runId => ({
          runId,
          code: 'hitch_verifier_evidence_unavailable',
          cause: 'verifier_evidence_capability_unavailable',
          resolution: 'upgrade-hitch' as const,
        }))
    return {
      schemaVersion: 1,
      code: value.code,
      failedOperation: value.failedOperation,
      blockedRuns,
    }
  }

  private async persistTrajectoryQueryBlockers(
    sessionId: string,
    roundId: string,
    baseline: EvaluationEvidence,
  ): Promise<void> {
    const blockedRuns = this.trajectoryBlockers(sessionId, roundId, baseline).map(item => ({
      runId: item.runId,
      code: item.code,
      ...(item.cause === undefined ? {} : { cause: item.cause }),
      ...(item.resolution === undefined ? {} : { resolution: item.resolution }),
    }))
    if (blockedRuns.length === 0) return
    await this.service.recordMetaPrerequisiteBlocker?.(sessionId, {
      schemaVersion: 1,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      failedOperation: 'trajectory.query',
      blockedRuns,
    })
  }

  private registerDetailRef(value: TrajectoryDetailRef): string {
    const ref = `detail_${randomBytes(16).toString('hex')}`
    this.trajectoryDetailRefs.set(ref, value)
    this.trimDetailRefs()
    return ref
  }

  private trimDetailRefs(): void {
    const cachedTexts = (): number => {
      const unique = new Set<string>()
      for (const value of this.trajectoryDetailRefs.values()) {
        if (value.text !== undefined) unique.add(value.text)
      }
      return [...unique].reduce((total, text) => total + Buffer.byteLength(text), 0)
    }
    while (this.trajectoryDetailRefs.size > 4_096 || cachedTexts() > 64 * 1024 * 1024) {
      const oldest = this.trajectoryDetailRefs.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.trajectoryDetailRefs.delete(oldest)
    }
  }

  private inlineDetailRef(
    sessionId: string,
    roundId: string,
    runId: string,
    text: string,
    sourceComplete = true,
  ): string {
    return this.registerDetailRef({ sessionId, roundId, runId, offset: 0, text, sourceComplete })
  }

  private evidenceText(
    sessionId: string,
    item: SeedRunEvidence,
    projection: TrajectoryProjection,
    value: ContentExcerpt,
    maxCharacters: number,
    heldOutRef: string | undefined,
  ): MetaEvidenceText {
    const joined = value.tail === undefined ? value.preview : `${value.preview}\n…\n${value.tail}`
    const safe = this.sanitize(joined, heldOutRef) as string
    const visible = boundedCharacters(safe, maxCharacters)
    const truncated = value.truncated || characterLength(safe) > maxCharacters
    if (!truncated) return { text: visible }
    const detailRef = value.source.seq === undefined
      ? this.inlineDetailRef(sessionId, item.roundId, item.trial.runId, safe)
      : this.registerDetailRef({
          sessionId,
          roundId: item.roundId,
          runId: item.trial.runId,
          offset: 0,
          source: {
            seq: value.source.seq,
            field: value.source.field,
            canonicalSha256: projection.trajectoryDigest,
            bytes: value.bytes,
          },
        })
    return { text: visible, truncated: true, detailRef }
  }

  private inlineEvidenceText(
    sessionId: string,
    item: SeedRunEvidence,
    text: string,
    maxCharacters: number,
    heldOutRef: string | undefined,
  ): MetaEvidenceText {
    const safe = this.sanitize(text, heldOutRef) as string
    if (characterLength(safe) <= maxCharacters) return { text: safe }
    return {
      text: boundedCharacters(safe, maxCharacters),
      truncated: true,
      detailRef: this.inlineDetailRef(sessionId, item.roundId, item.trial.runId, safe),
    }
  }

  private verifierCard(
    sessionId: string,
    item: SeedRunEvidence,
    evidence: HitchVerifierEvidence,
    heldOutRef: string | undefined,
    detailBytes: number,
  ): MetaFailureCard['verifier'] {
    const status = evidence.verifier.status === 'corrupt' ? 'unavailable' : evidence.verifier.status
    const process = evidence.verifier.process === undefined ? undefined : publicJson(this.sanitize({
      schemaVersion: evidence.verifier.process.schemaVersion,
      metric: evidence.verifier.process.metric,
      score: evidence.verifier.process.score,
      detailStatus: evidence.verifier.process.detailStatus,
      ...(evidence.verifier.process.passed === undefined ? {} : { passed: evidence.verifier.process.passed }),
      ...(evidence.verifier.process.total === undefined ? {} : { total: evidence.verifier.process.total }),
      ...(evidence.verifier.process.excluded === undefined ? {} : { excluded: evidence.verifier.process.excluded }),
      ...(evidence.verifier.process.components === undefined ? {} : {
        components: evidence.verifier.process.components.map(component => ({
          id: component.id,
          category: component.category,
          status: component.status,
          weight: component.weight,
          ...(component.code === undefined ? {} : { code: component.code }),
          ...(component.publicDetails === undefined ? {} : { publicDetails: component.publicDetails }),
          ...(component.trajectoryRefs === undefined ? {} : { trajectoryRefs: component.trajectoryRefs }),
        })),
      }),
    }, heldOutRef)) as unknown as NonNullable<HitchVerifierEvidence['verifier']['process']>
    // Redact before clipping so a preview cannot split and expose a secret.
    const feedback = evidence.verifier.feedback === undefined ? undefined
      : publicJson(this.sanitize(evidence.verifier.feedback, heldOutRef)) as unknown as NonNullable<HitchVerifierEvidence['verifier']['feedback']>
    const processPreview = process === undefined ? undefined : previewVerifierProcess(process)
    const feedbackPreview = feedback === undefined ? undefined : previewVerifierFeedback(feedback)
    const safeDiagnostics = evidence.verifier.diagnostics === undefined
      ? undefined
      : this.sanitize(evidence.verifier.diagnostics, heldOutRef)
    const diagnostics = objectValue(safeDiagnostics)
    const ctrf = objectValue(diagnostics?.ctrf)
    const ctrfJson = objectValue(ctrf?.json)
    const results = objectValue(ctrfJson?.results)
    const summary = objectValue(results?.summary)
    const tests = Array.isArray(results?.tests) ? results.tests : []
    const failedTests = tests.flatMap(test => {
      const value = objectValue(test)
      if (value === undefined || value.status === 'passed' || value.status === 'skipped') return []
      const name = typeof value.name === 'string' ? value.name : 'unnamed verifier check'
      const detail = [value.message, value.trace]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n') || `Verifier status: ${String(value.status ?? 'failed')}`
      return [{
        name: boundedUtf8(name, 240),
        detail: this.inlineEvidenceText(sessionId, item, detail, detailBytes, heldOutRef),
      }]
    }).slice(0, 5)
    const summaryText = summary === undefined
      ? status === 'missing'
        ? 'Verifier result is missing.'
        : status === 'result_only'
          ? 'Verifier returned a result without diagnostic artifacts.'
          : evidence.verifier.issues?.[0] ?? 'Verifier diagnostics are available.'
      : `${String(summary.passed ?? 0)} passed, ${String(summary.failed ?? failedTests.length)} failed, ${String(summary.skipped ?? 0)} skipped.`
    const detailChunks: string[] = []
    for (const [label, value] of [
      ['SCORES', evidence.verifier.scores],
      ['PROCESS', process],
      ['FEEDBACK', feedback],
    ] as const) {
      if (value !== undefined) {
        // Detail refs cache serialized text, so apply the same public-field
        // projection and redaction as the card before serializing it.
        detailChunks.push(`${label}\n${JSON.stringify(publicJson(this.sanitize(value, heldOutRef)), null, 2)}`)
      }
    }
    const pagedArtifacts: NonNullable<TrajectoryDetailRef['verifierSources']>['artifacts'] = []
    const appendArtifact = (label: string, value: unknown): void => {
      const artifact = objectValue(value)
      if (artifact === undefined) return
      if (artifact.truncated === true) {
        const name = artifact.name
        const mediaType = artifact.media_type
        const bytes = artifact.bytes
        const sha256 = artifact.sha256
        if ((name === 'ctrf.json' || name === 'test-stdout.txt' || name === 'test-stderr.txt'
          || name === 'stdout.txt' || name === 'stderr.txt')
          && (mediaType === 'application/json' || mediaType === 'text/plain')
          && Number.isSafeInteger(bytes) && (bytes as number) >= 0
          && typeof sha256 === 'string' && /^sha256:[0-9a-f]{64}$/u.test(sha256)) {
          pagedArtifacts.push({ label, name, mediaType, bytes: bytes as number, sha256 })
          return
        }
      }
      if (artifact.json !== undefined) detailChunks.push(`${label}\n${JSON.stringify(artifact.json, null, 2)}`)
      else if (typeof artifact.text === 'string') detailChunks.push(`${label}\n${artifact.text}`)
    }
    appendArtifact('CTRF', diagnostics?.ctrf)
    for (const stream of ['stdout', 'stderr'] as const) {
      const artifacts = diagnostics?.[stream]
      if (!Array.isArray(artifacts)) continue
      for (const artifact of artifacts) {
        const name = objectValue(artifact)?.name
        appendArtifact(`${stream.toUpperCase()}${typeof name === 'string' ? ` ${name}` : ''}`, artifact)
      }
    }
    if (diagnostics?.infrastructure_error !== undefined) {
      detailChunks.push(`INFRASTRUCTURE ERROR\n${JSON.stringify(diagnostics.infrastructure_error, null, 2)}`)
    }
    if (diagnostics?.retry_history !== undefined) {
      detailChunks.push(`RETRY HISTORY\n${JSON.stringify(diagnostics.retry_history, null, 2)}`)
    }
    const diagnosticsText = detailChunks.length === 0 ? undefined : detailChunks.join('\n\n')
    // Structured artifacts can be usable even without legacy diagnostics
    // (result_only). Omitted evidence must be read before issuing a receipt.
    const hasDetails = diagnosticsText !== undefined || pagedArtifacts.length > 0
    const needsDetail = (status === 'complete' || status === 'result_only') && hasDetails
      && (pagedArtifacts.length > 0 || (status === 'complete' && failedTests.length === 0)
        || processPreview?.truncated === true || feedbackPreview?.truncated === true)
    return {
      status,
      summary: boundedUtf8(this.sanitize(summaryText, heldOutRef) as string, 600),
      ...(evidence.verifier.scores === undefined ? {} : { scores: evidence.verifier.scores }),
      ...(processPreview === undefined ? {} : { process: processPreview }),
      ...(feedbackPreview === undefined ? {} : { feedback: feedbackPreview }),
      ...(failedTests.length === 0 ? {} : { failures: failedTests }),
      ...(!hasDetails ? {} : {
        detailRef: pagedArtifacts.length === 0
          ? this.inlineDetailRef(sessionId, item.roundId, item.trial.runId, diagnosticsText!)
          : this.registerDetailRef({
              sessionId,
              roundId: item.roundId,
              runId: item.trial.runId,
              offset: 0,
              verifierSources: {
                ...(diagnosticsText === undefined ? {} : { baseText: diagnosticsText }),
                artifacts: pagedArtifacts,
              },
            }),
      }),
      ...(needsDetail ? { needsDetail: true as const } : {}),
    }
  }

  private failureCard(
    sessionId: string,
    item: SeedRunEvidence,
    projection: TrajectoryProjection,
    verifierEvidence: HitchVerifierEvidence,
    heldOutRef: string | undefined,
    maxTranscript = 80_000,
    transcriptBudget: 'characters' | 'bytes' = 'characters',
  ): MetaFailureCard {
    const reward = item.trial.rewards?.reward ?? Object.values(item.trial.rewards ?? {})[0]
    const actions = projection.semanticSteps.flatMap(step => step.toolActions)
    const pairedToolResults = new Set(actions.flatMap(action =>
      action.resultSeq === undefined ? [] : [action.resultSeq]))
    const blocks: Array<{ seq: number; order: number; text: string }> = []

    for (const message of projection.messages) {
      if (message.eventType === 'tool/result' && pairedToolResults.has(message.seq)) continue
      const isToolResult = message.eventType === 'tool/result' || message.role === 'tool'
      const evidence = this.evidenceText(
        sessionId,
        item,
        projection,
        message.message,
        isToolResult ? 2_000 : 80_000,
        heldOutRef,
      )
      if (evidence.text.trim().length === 0 && evidence.detailRef === undefined) continue
      const label = message.eventType === 'user/message' && message.role === 'user'
        ? 'USER'
        : message.eventType === 'assistant/message' && message.role === 'assistant'
          ? 'ASSISTANT'
          : 'TOOL RESULT'
      blocks.push({ seq: message.seq, order: 0, text: `${label}\n${renderedMetaEvidence(evidence)}` })
    }

    for (const action of actions) {
      const input = this.evidenceText(
        sessionId, item, projection, action.arguments, 80_000, heldOutRef,
      )
      const output = action.result === undefined
        ? undefined
        : this.evidenceText(sessionId, item, projection, action.result, 2_000, heldOutRef)
      blocks.push({
        seq: action.callSeq,
        order: 1,
        text: [
          `TOOL ${boundedUtf8(action.name, 96)} · ${action.status}`,
          `input: ${renderedMetaEvidence(input)}`,
          ...(output === undefined ? [] : [`output: ${renderedMetaEvidence(output)}`]),
        ].join('\n'),
      })
    }

    blocks.sort((left, right) => left.seq - right.seq || left.order - right.order)
    return publicJson(this.sanitize({
      task: boundedUtf8(item.trial.taskName, 240),
      runId: item.trial.runId,
      outcome: {
        status: item.trial.status,
        ...(reward === undefined ? {} : { reward }),
        ...(item.trial.invalidReason === undefined ? {} : {
          invalidReason: boundedUtf8(item.trial.invalidReason, 300),
        }),
      },
      verifier: this.verifierCard(sessionId, item, verifierEvidence, heldOutRef, 2_000),
      transcript: this.transcriptWindow(
        sessionId, item, blocks.map(block => block.text), maxTranscript, transcriptBudget,
      ),
    }, heldOutRef)) as unknown as MetaFailureCard
  }

  private transcriptWindow(
    sessionId: string,
    item: SeedRunEvidence,
    blocks: readonly string[],
    maxSize = 80_000,
    budget: 'characters' | 'bytes' = 'characters',
  ): MetaFailureCard['transcript'] {
    let firstVisible = blocks.length
    let visibleSize = 0
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const separatorSize = firstVisible === blocks.length ? 0 : 2
      const blockSize = budget === 'bytes' ? Buffer.byteLength(blocks[index]!) : characterLength(blocks[index]!)
      const nextSize = blockSize + separatorSize
      if (visibleSize + nextSize > maxSize) break
      firstVisible = index
      visibleSize += nextSize
    }
    if (firstVisible === 0) return { text: blocks.join('\n\n') }
    if (firstVisible === blocks.length && blocks.length > 0) {
      const split = budget === 'bytes'
        ? splitUtf8Tail(blocks.at(-1)!, maxSize)
        : (() => {
            const finalCharacters = characters(blocks.at(-1)!)
            const splitAt = Math.max(0, finalCharacters.length - maxSize)
            return {
              earlier: finalCharacters.slice(0, splitAt).join(''),
              tail: finalCharacters.slice(splitAt).join(''),
            }
          })()
      const earlier = [...blocks.slice(0, -1), split.earlier]
        .filter(Boolean)
        .join('\n\n')
      return {
        text: split.tail,
        earlierRef: this.inlineDetailRef(sessionId, item.roundId, item.trial.runId, earlier),
      }
    }
    return {
      text: blocks.slice(firstVisible).join('\n\n'),
      earlierRef: this.inlineDetailRef(
        sessionId, item.roundId, item.trial.runId, blocks.slice(0, firstVisible).join('\n\n'),
      ),
    }
  }

  private diagnosisReceiptForCard(
    runId: string,
    cardDigest: string,
    trajectoryDigest: string,
    verifierStatus: DiagnosisReceipt['verifierStatus'],
    sourceVerifierStatus: HitchVerifierEvidence['verifier']['status'],
  ): DiagnosisReceipt {
    return {
      runId,
      bundleDigest: cardDigest,
      trajectoryDigest,
      projectionVersion: 1,
      verifierStatus,
      ...(verifierStatus === 'unavailable' && sourceVerifierStatus === 'unavailable'
        && this.options.allowUnavailableVerifierDiagnosis === true
        ? { compatibility: 'allow-unavailable-verifier' as const }
        : {}),
      sanitizationPolicyDigest: this.sanitizationPolicyDigest(),
      inspectedAt: new Date().toISOString(),
    }
  }

  private async readTrajectoryDetail(
    sessionId: string,
    roundId: string,
    ref: string,
    find: string | undefined,
    heldOutRef: string | undefined,
    signal: AbortSignal,
  ): Promise<TrajectoryDetailRead> {
    const detail = this.trajectoryDetailRefs.get(ref)
    if (detail === undefined || detail.sessionId !== sessionId || detail.roundId !== roundId) {
      throw new Error('detailRef is unknown or no longer valid for this Meta task')
    }
    if (find !== undefined && find.length > 500) throw new TypeError('find must be at most 500 characters')
    if (detail.verifierSources !== undefined) {
      try {
        await this.materializeVerifierDetails(detail, heldOutRef, signal)
        this.trajectoryEvidenceBlockers.delete(this.trajectoryBlockerKey(sessionId, roundId, detail.runId))
      } catch (error) {
        signal.throwIfAborted()
        const blocker = this.recordTrajectoryBlocker(sessionId, roundId, detail.runId, error)
        return { visible: this.trajectoryEvidenceBlocked([blocker]), blocker }
      }
    }
    let text = detail.text
    let sourceComplete = detail.sourceComplete ?? true
    if (text === undefined) {
      if (detail.source === undefined || this.options.trajectoryReader === undefined) {
        throw new Error('detailRef source is unavailable')
      }
      const source = detail.source
      const page = await this.options.trajectoryReader.inspectTrajectoryEvents(detail.runId, {
        seqStart: source.seq,
        seqEnd: source.seq,
        field: source.field,
        canonicalSha256: source.canonicalSha256,
        limit: 1,
        maxBytes: Math.min(4 * 1024 * 1024, Math.max(this.maxTrajectoryPageBytes, source.bytes + 64 * 1024)),
      }, signal)
      const event = objectValue(page.events[0])
      const excerpt = objectValue(event?.event_excerpt)
      const completeValue = event !== undefined && Object.hasOwn(event, 'value')
        ? event.value
        : excerpt !== undefined && Object.hasOwn(excerpt, 'value')
          ? excerpt.value
          : undefined
      if (completeValue !== undefined) {
        text = source.field === 'data.arguments'
          ? (() => {
              const value = completeValue
              if (typeof value !== 'string') return JSON.stringify(this.sanitize(value, heldOutRef), null, 2)
              try { return JSON.stringify(this.sanitize(JSON.parse(value), heldOutRef), null, 2) }
              catch { return value }
            })()
          : readableMessage(completeValue)
        sourceComplete = true
      } else if (typeof excerpt?.preview === 'string') {
        text = 'The upstream source retained only an incomplete excerpt; its content cannot be safely reconstructed.'
        sourceComplete = false
      } else {
        throw new Error('detailRef no longer resolves to readable trajectory content')
      }
      text = this.sanitize(text, heldOutRef) as string
      detail.text = text
      detail.sourceComplete = sourceComplete
      this.trimDetailRefs()
    }
    if (find !== undefined) {
      const matches: string[] = []
      const haystack = text.toLocaleLowerCase()
      const needle = find.toLocaleLowerCase()
      let cursor = detail.offset
      while (matches.length < 5) {
        const match = haystack.indexOf(needle, cursor)
        if (match < 0) break
        matches.push(boundedUtf8(text.slice(Math.max(0, match - 180), match + find.length + 220), 500))
        cursor = match + Math.max(1, find.length)
      }
      const more = haystack.indexOf(needle, cursor) >= 0
      const nextRef = more
        ? this.registerDetailRef({ ...detail, offset: cursor })
        : undefined
      const visible = {
        detail: {
          matches,
          complete: sourceComplete && !more,
        },
        ...(nextRef === undefined ? {} : { nextRef }),
      }
      return this.completeTrajectoryDetailRead(detail, visible, false)
    }
    const maxBytes = Math.min(16 * 1024, this.maxTrajectoryPageBytes)
    let end = Math.min(text.length, detail.offset + maxBytes)
    while (end > detail.offset && Buffer.byteLength(text.slice(detail.offset, end)) > maxBytes) end -= 1
    const pageText = text.slice(detail.offset, end)
    const nextRef = end < text.length
      ? this.registerDetailRef({ ...detail, offset: end })
      : undefined
    const visible = {
      detail: {
        text: pageText,
        complete: sourceComplete && nextRef === undefined,
      },
      ...(nextRef === undefined ? {} : { nextRef }),
    }
    return this.completeTrajectoryDetailRead(detail, visible, sourceComplete && nextRef === undefined)
  }

  private async materializeVerifierDetails(
    detail: TrajectoryDetailRef,
    heldOutRef: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const sources = detail.verifierSources
    if (sources === undefined) return
    const inspect = this.options.trajectoryReader?.inspectVerifierDiagnosticPage
    if (inspect === undefined) {
      throw Object.assign(new Error('Hitch does not expose bounded verifier diagnostic pages'), {
        code: 'hitch_verifier_diagnostic_pages_unavailable',
        cause: 'verifier_diagnostic_pages_unsupported',
        resolution: 'upgrade-hitch',
      })
    }
    const chunks = sources.baseText === undefined ? [] : [sources.baseText]
    let aggregateBytes = 0
    for (const source of sources.artifacts) {
      let offset = 0
      let expectedSha256: string | undefined
      let expectedBytes: number | undefined
      const artifactChunks: string[] = []
      const hash = createHash('sha256')
      let bytes = 0
      for (;;) {
        const page = await inspect.call(this.options.trajectoryReader, detail.runId, {
          name: source.name,
          offset,
          limit: VERIFIER_DIAGNOSTIC_PAGE_BYTES,
          ...(expectedSha256 === undefined ? {} : { sha256: expectedSha256 }),
        }, signal)
        if (!page.artifact.sourceComplete) {
          const cause = page.artifact.lossReason ?? 'source_incomplete'
          throw Object.assign(new Error(`persisted verifier diagnostic source is incomplete (${cause})`), {
            code: 'hitch_verifier_diagnostic_source_incomplete',
            cause: /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(cause) ? cause : 'source_incomplete',
            resolution: 'repair-evidence',
          })
        }
        if (expectedSha256 === undefined) {
          expectedSha256 = page.artifact.sha256
          expectedBytes = page.artifact.bytes
          if (page.artifact.name !== source.name || page.artifact.mediaType !== source.mediaType
            || page.artifact.sha256 !== source.sha256 || page.artifact.bytes !== source.bytes) {
            throw Object.assign(new Error('verifier diagnostic identity changed after the diagnostic card was issued'), {
              code: 'verifier_diagnostic_version_mismatch',
              cause: 'verifier_diagnostic_version_mismatch',
              resolution: 'repair-evidence',
            })
          }
          if (expectedBytes > MAX_VERIFIER_DIAGNOSTIC_BYTES) {
            throw Object.assign(new Error('verifier diagnostic exceeds the Gear evidence limit'), {
              code: 'hitch_verifier_diagnostic_too_large',
              cause: 'diagnostic_too_large',
              resolution: 'repair-evidence',
            })
          }
        } else if (page.artifact.sha256 !== expectedSha256 || page.artifact.bytes !== expectedBytes
          || page.artifact.name !== source.name || page.artifact.mediaType !== source.mediaType) {
          throw Object.assign(new Error('verifier diagnostic identity changed between pages'), {
            code: 'verifier_diagnostic_version_mismatch',
            cause: 'verifier_diagnostic_version_mismatch',
            resolution: 'repair-evidence',
          })
        }
        bytes += page.page.bytes
        aggregateBytes += page.page.bytes
        if (bytes > MAX_VERIFIER_DIAGNOSTIC_BYTES || aggregateBytes > MAX_VERIFIER_DIAGNOSTIC_BYTES) {
          throw Object.assign(new Error('verifier diagnostics exceed the Gear evidence limit'), {
            code: 'hitch_verifier_diagnostic_too_large',
            cause: 'diagnostic_too_large',
            resolution: 'repair-evidence',
          })
        }
        hash.update(page.page.text)
        artifactChunks.push(page.page.text)
        if (page.page.eof) break
        offset = page.page.nextOffset!
      }
      const digest = `sha256:${hash.digest('hex')}`
      if (bytes !== expectedBytes || digest !== expectedSha256) {
        throw Object.assign(new Error('verifier diagnostic bytes or digest do not match the completed page stream'), {
          code: 'hitch_verifier_diagnostic_integrity_mismatch',
          cause: 'verifier_diagnostic_integrity_mismatch',
          resolution: 'repair-evidence',
        })
      }
      const artifactText = artifactChunks.join('')
      const safe = this.sanitize(artifactText, heldOutRef) as string
      chunks.push(`${source.label}\n${safe}`)
    }
    const text = chunks.join('\n\n')
    if (Buffer.byteLength(text) > MAX_VERIFIER_DIAGNOSTIC_BYTES) {
      throw Object.assign(new Error('sanitized verifier diagnostics exceed the Gear evidence limit'), {
        code: 'hitch_verifier_diagnostic_too_large',
        cause: 'sanitized_diagnostic_too_large',
        resolution: 'repair-evidence',
      })
    }
    detail.text = text
    detail.sourceComplete = true
    Reflect.deleteProperty(detail, 'verifierSources')
    this.trimDetailRefs()
  }

  private completeTrajectoryDetailRead(
    detail: TrajectoryDetailRef,
    visible: Record<string, unknown>,
    complete: boolean,
  ): TrajectoryDetailRead {
    const pending = detail.pendingDiagnosis
    if (pending === undefined || pending.recorded) return { visible }
    pending.visibleDigests.push(digestJson(visible))
    if (!complete) {
      const hasContinuation = typeof visible.nextRef === 'string'
      if (!hasContinuation && detail.sourceComplete === false) {
        this.recordTrajectoryBlocker(
          detail.sessionId,
          detail.roundId,
          detail.runId,
          Object.assign(new Error('required verifier diagnostics are only available as an incomplete excerpt'), {
            code: 'hitch_verifier_diagnostics_incomplete',
          }),
        )
      }
      return { visible }
    }
    return {
      visible,
      diagnosis: {
        evalId: pending.evalId,
        runId: detail.runId,
        ...(pending.recovery === undefined ? {} : { recovery: {
          ...pending.recovery,
          evidence: { ...pending.recovery.evidence, verifierDetails: detail.text ?? '' },
        } }),
        receipt: this.diagnosisReceiptForCard(
          detail.runId,
          digestJson({ card: pending.cardDigest, details: pending.visibleDigests }),
          pending.trajectoryDigest,
          pending.verifierStatus,
          pending.sourceVerifierStatus,
        ),
      },
    }
  }

  private seedRunEvidence(rounds: RefinementRound[]): SeedRunEvidence[] {
    const values: SeedRunEvidence[] = []
    for (const round of rounds) {
      const append = (phase: SeedRunEvidence['phase'], evidence: EvaluationEvidence | undefined): void => {
        if (evidence === undefined) return
        for (const { originalResult: privateOriginal, ...trial } of evidence.trials) {
          if (trial.runId !== undefined) values.push({ evolutionId: round.evolutionId, roundId: round.roundId, phase, evalId: evidence.evalId, trial: { ...trial, runId: trial.runId } })
        }
        for (const { originalResult: privateOriginal, ...trial } of evidence.invalidTrials) {
          values.push({ evolutionId: round.evolutionId, roundId: round.roundId, phase, evalId: evidence.evalId, trial: { ...trial } })
        }
      }
      append('seed-baseline', round.baseline)
      append('seed-candidate', round.evaluation?.seedCandidate)
      for (const failed of round.failedEvaluations ?? []) {
        if (failed.phase !== 'seed-baseline' && failed.phase !== 'seed-candidate') continue
        for (const trial of failed.evidence.trials) {
          values.push({
            evolutionId: round.evolutionId,
            roundId: round.roundId,
            phase: failed.phase,
            evalId: failed.evidence.evalId,
            trial: { ...trial },
            failure: { ...failed.failure },
          })
        }
      }
    }
    return values
  }

  private resolveSeedRefs(refs: string[], evidence: SeedRunEvidence[], roundId?: string): SeedRunEvidence[] {
    const selected = new Map<string, SeedRunEvidence>()
    for (const ref of refs) {
      const matches = evidence.filter(item => (roundId === undefined || item.roundId === roundId)
        && item.trial.runId === ref)
      if (matches.length === 0) throw new Error(`trajectory ref is not a recorded seed run: ${ref}`)
      for (const item of matches) selected.set(item.trial.runId, item)
    }
    return [...selected.values()]
  }

  private sanitize(value: unknown, heldOutRef: string | undefined, key?: string): JsonValue {
    return sanitizePublicValue(value, heldOutRef, this.secretValues, key)
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

  private optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} must be a non-empty string`)
    return value
  }

  private optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
    return value
  }

  private optionalStrings(args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
      throw new TypeError(`${key} must be an array of non-empty strings`)
    }
    return value as string[]
  }

  private finalization(args: Record<string, unknown>): CandidateFinalization {
    const rationale = this.string(args, 'rationale')
    const expectedOutcome = this.string(args, 'expectedOutcome')
    const evidenceRefs = this.optionalStrings(args, 'evidenceRefs')
    if (evidenceRefs === undefined || evidenceRefs.length === 0) throw new TypeError('evidenceRefs must contain current baseline evidence')
    const semanticTargets = this.optionalStrings(args, 'semanticTargets')
    const allowed = new Set<SemanticTarget>([
      'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
      'skill', 'tool', 'workflow', 'compaction',
    ])
    if (semanticTargets?.some(value => !allowed.has(value as SemanticTarget))) throw new TypeError('semanticTargets contains an unknown target')
    return {
      rationale, expectedOutcome, evidenceRefs: [...new Set(evidenceRefs)],
      ...(semanticTargets === undefined ? {} : { semanticTargets: [...new Set(semanticTargets)] as SemanticTarget[] }),
    }
  }
}

function roundHeldOutRef(
  rounds: RefinementRound[],
  roundId: string,
): string | undefined {
  return rounds.find(round => round.roundId === roundId)?.heldOutRef
}

export type CapabilityMethod = keyof RefineBridgeRequestMap
