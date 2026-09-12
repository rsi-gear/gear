import { readFile } from 'node:fs/promises'
import { seedOnlyStatus } from './search/public-status.js'
import { randomBytes } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { HarnessBuilder } from './harness/builder.js'
import { CompilerCheckError, candidateCheckReport, uncheckedRuntime, type CandidateCheckReport } from './harness/check-report.js'
import type { RefineService } from './refine/service.js'
import { projectTrajectory } from './evaluator/trajectory-projection.js'
import { digestJson } from './state/digest.js'
import type { CandidateDiagnosisRecord } from './state/candidate-diagnosis.js'
import { finalizationReadiness, receiptIsValid, recoveryRequired } from './refine/finalization-readiness.js'
import { previewVerifierFeedback, previewVerifierProcess } from './meta/verifier-preview.js'
import type {
  CandidateFinalization,
  ContentExcerpt,
  DiagnosisReceipt,
  EvaluationEvidence,
  HitchTrajectoryReader,
  HitchVerifierEvidence,
  MetaEvidenceText,
  MetaFailureCard,
  RefineBridgeRequestMap,
  RefinementRound,
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

interface TrajectoryDetailRead {
  visible: Record<string, unknown>
  diagnosis?: { evalId: string; runId: string; receipt: DiagnosisReceipt; recovery?: Omit<CandidateDiagnosisRecord, 'receipt' | 'source'> }
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

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/iu

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  const prefix = Buffer.from(value).subarray(0, budget).toString('utf8').replace(/\uFFFD+$/u, '')
  return `${prefix}${suffix}`
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
        if (read.diagnosis !== undefined) {
          if (read.diagnosis.recovery !== undefined) await this.service.recordCandidateDiagnosis?.(sessionId, {
            ...read.diagnosis.recovery, receipt: read.diagnosis.receipt,
          })
          signal.throwIfAborted()
          meta.recordEvidenceAccess(activeRoundId, sessionId, {
            refs: [read.diagnosis.evalId, read.diagnosis.runId], diagnosisReceipts: [read.diagnosis.receipt],
          })
          const pending = this.trajectoryDetailRefs.get(detailRef)?.pendingDiagnosis
          if (pending !== undefined) pending.recorded = true
        }
        return publicJson(read.visible)
      }
      const evidence: SeedRunEvidence[] = baseline === undefined ? this.seedRunEvidence(rounds) : [
        ...baseline.trials.flatMap(trial => trial.runId === undefined ? [] : [{
          evolutionId,
          roundId: activeRoundId,
          phase: 'seed-baseline' as const,
          evalId: baseline.evalId,
          trial: { ...trial, runId: trial.runId },
        }]),
        ...baseline.invalidTrials.map(trial => ({
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
            || (item.trial.rewards?.reward ?? Object.values(item.trial.rewards ?? {})[0] ?? 0) <= 0
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
          this.trajectoryEvidenceBlockers.delete(this.trajectoryBlockerKey(sessionId, item.roundId, item.trial.runId))
        } catch (error) {
          const blocker = this.recordTrajectoryBlocker(sessionId, item.roundId, item.trial.runId, error)
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
            ...baseline.invalidTrials.map(trial => ({ ...trial })),
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
        if (recovery !== undefined) return publicJson(recovery)
      }
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
    return digestJson({ sensitiveKeyPattern: SENSITIVE_KEY.source,
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
    const source = error as { code?: unknown }
    const code = typeof source?.code === 'string' && /^[a-z0-9_]{1,128}$/u.test(source.code)
      ? source.code
      : 'hitch_trajectory_project_failed'
    const blocker = {
      runId,
      code,
      message: `Bounded trajectory evidence could not be constructed for ${runId} (${code}).`,
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
      ...baseline.trials.filter(trial => (trial.rewards.reward ?? Object.values(trial.rewards)[0] ?? 0) <= 0)
        .flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...baseline.invalidTrials.map(trial => trial.runId),
    ])
    return [...required].flatMap(runId => {
      const blocker = this.trajectoryEvidenceBlockers.get(this.trajectoryBlockerKey(sessionId, roundId, runId))
      return blocker === undefined ? [] : [blocker]
    }).sort((left, right) => left.runId.localeCompare(right.runId))
  }

  private trajectoryEvidenceBlocked(blockers: readonly TrajectoryEvidenceBlocker[]): Record<string, unknown> {
    return {
      schemaVersion: 1,
      runs: [],
      batchAccepted: false,
      recoverable: false,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      message: `Diagnostic cards could not be constructed for ${blockers.length} run${blockers.length === 1 ? '' : 's'}. Do not retry the same query until Hitch or the trajectory evidence is repaired.`,
      blockedRuns: blockers,
      operatorAction: {
        upgrade: 'Hitch bounded trajectory analysis capability',
        runIds: blockers.map(item => item.runId),
        reason: blockers.map(item => item.code).join(','),
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
        const resolveParent = this.options.trajectoryReader?.resolveVerifierEvaluationId
        const expectedEvalId = resolveParent === undefined ? item.evalId
          : await resolveParent.call(this.options.trajectoryReader, item.evalId, item.trial.runId, signal)
        if (typeof expectedEvalId !== 'string' || expectedEvalId.length === 0
          || evidence.parent.evalId !== expectedEvalId) {
          throw new Error(`verifier evidence eval identity mismatch for ${item.trial.runId}`)
        }
        if (item.trial.trialName !== undefined && evidence.parent.trialId !== item.trial.trialName) {
          throw new Error(`verifier evidence trial identity mismatch for ${item.trial.runId}`)
        }
        if (item.trial.attempt !== undefined && evidence.parent.attempt !== item.trial.attempt) {
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
    let diagnosticsComplete = true
    const appendArtifact = (label: string, value: unknown): void => {
      const artifact = objectValue(value)
      if (artifact === undefined) return
      if (artifact.truncated === true) diagnosticsComplete = false
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
    const needsDetail = (status === 'complete' || status === 'result_only') && diagnosticsText !== undefined
      && ((status === 'complete' && failedTests.length === 0)
        || processPreview?.truncated === true || feedbackPreview?.truncated === true)
    return {
      status,
      summary: boundedUtf8(this.sanitize(summaryText, heldOutRef) as string, 600),
      ...(evidence.verifier.scores === undefined ? {} : { scores: evidence.verifier.scores }),
      ...(processPreview === undefined ? {} : { process: processPreview }),
      ...(feedbackPreview === undefined ? {} : { feedback: feedbackPreview }),
      ...(failedTests.length === 0 ? {} : { failures: failedTests }),
      ...(diagnosticsText === undefined ? {} : {
        detailRef: this.inlineDetailRef(
          sessionId, item.roundId, item.trial.runId, diagnosticsText, diagnosticsComplete,
        ),
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
      transcript: this.transcriptWindow(sessionId, item, blocks.map(block => block.text)),
    }, heldOutRef)) as unknown as MetaFailureCard
  }

  private transcriptWindow(
    sessionId: string,
    item: SeedRunEvidence,
    blocks: readonly string[],
  ): MetaFailureCard['transcript'] {
    const maxCharacters = 80_000
    let firstVisible = blocks.length
    let visibleCharacters = 0
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const separatorCharacters = firstVisible === blocks.length ? 0 : 2
      const nextCharacters = characterLength(blocks[index]!) + separatorCharacters
      if (visibleCharacters + nextCharacters > maxCharacters) break
      firstVisible = index
      visibleCharacters += nextCharacters
    }
    if (firstVisible === 0) return { text: blocks.join('\n\n') }
    if (firstVisible === blocks.length && blocks.length > 0) {
      const finalCharacters = characters(blocks.at(-1)!)
      const split = Math.max(0, finalCharacters.length - maxCharacters)
      const earlier = [...blocks.slice(0, -1), finalCharacters.slice(0, split).join('')]
        .filter(Boolean)
        .join('\n\n')
      return {
        text: finalCharacters.slice(split).join(''),
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
        for (const trial of evidence.trials) {
          if (trial.runId !== undefined) values.push({ evolutionId: round.evolutionId, roundId: round.roundId, phase, evalId: evidence.evalId, trial: { ...trial, runId: trial.runId } })
        }
        for (const trial of evidence.invalidTrials) {
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
    if (key !== undefined && SENSITIVE_KEY.test(key)) return '[REDACTED]'
    if (typeof value === 'string') {
      let text = value
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { text = JSON.stringify(this.sanitize(JSON.parse(text), heldOutRef), null, 2) }
        catch { /* Ordinary text that merely starts like JSON. */ }
      }
      for (const secret of this.secretValues) text = text.split(secret).join('[REDACTED]')
      if (heldOutRef !== undefined && heldOutRef.length > 0) text = text.split(heldOutRef).join('[REDACTED_HELD_OUT]')
      return text
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map(item => this.sanitize(item, heldOutRef))
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [
        this.sanitizeKey(name, heldOutRef),
        this.sanitize(item, heldOutRef, name),
      ])) as JsonValue
    }
    return String(value)
  }

  private sanitizeKey(name: string, heldOutRef: string | undefined): string {
    let result = name
    for (const secret of this.secretValues) result = result.split(secret).join('[REDACTED]')
    if (heldOutRef !== undefined && heldOutRef.length > 0) {
      result = result.split(heldOutRef).join('[REDACTED_HELD_OUT]')
    }
    return result
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
