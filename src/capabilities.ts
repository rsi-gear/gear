import { readFile } from 'node:fs/promises'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { HarnessBuilder } from './harness/builder.js'
import type { RefineService } from './refine/service.js'
import { contentExcerpt, projectTrajectory, selectKeySteps } from './evaluator/trajectory-projection.js'
import { digestJson } from './state/digest.js'
import { finalizationReadiness, recoveryRequired } from './refine/finalization-readiness.js'
import type {
  CandidateFinalization,
  ContentExcerpt,
  DiagnosisReceipt,
  EvaluationEvidence,
  GearFailureBundle,
  HitchTrajectoryReader,
  HitchVerifierEvidence,
  RefineBridgeRequestMap,
  RefinementRound,
  SemanticTarget,
  SessionRole,
  TrajectoryContextEpoch,
  TrajectoryEvidenceBlocker,
  TrajectoryMessageEvidence,
  TrajectoryProjection,
  TrajectorySemanticStep,
  TrajectoryToolAction,
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

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|credential|password|secret|token)/iu

function compactExcerpt(value: ContentExcerpt, maxJsonBytes = 1_200): ContentExcerpt {
  let preview = value.preview
  let tail = value.tail
  let compacted: ContentExcerpt = { ...value }
  while (Buffer.byteLength(JSON.stringify(compacted)) > maxJsonBytes && (preview.length > 0 || (tail?.length ?? 0) > 0)) {
    preview = preview.slice(0, Math.floor(preview.length * 0.7))
    tail = tail === undefined ? undefined : tail.slice(Math.ceil(tail.length * 0.3))
    compacted = {
      ...value,
      preview,
      ...(tail === undefined || tail.length === 0 ? {} : { tail }),
      truncated: true,
    }
  }
  return compacted
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  const prefix = Buffer.from(value).subarray(0, budget).toString('utf8').replace(/\uFFFD+$/u, '')
  return `${prefix}${suffix}`
}

function compactMessage(value: TrajectoryMessageEvidence, excerptBytes = 1_200): TrajectoryMessageEvidence {
  return {
    ...value,
    eventType: boundedUtf8(value.eventType, 96),
    role: boundedUtf8(value.role, 96),
    message: compactExcerpt(value.message, excerptBytes),
  }
}

function compactToolAction(value: TrajectoryToolAction, excerptBytes = 1_200): TrajectoryToolAction {
  return {
    ...value,
    callId: boundedUtf8(value.callId, 128),
    name: boundedUtf8(value.name, 128),
    arguments: compactExcerpt(value.arguments, excerptBytes),
    ...(value.result === undefined ? {} : { result: compactExcerpt(value.result, excerptBytes) }),
    ...(value.error === undefined ? {} : {
      error: {
        name: boundedUtf8(value.error.name, 96),
        code: boundedUtf8(value.error.code, 96),
      },
    }),
  }
}

function compactStep(
  value: TrajectorySemanticStep,
  runId: string,
  options: { excerptBytes: number; maxToolActions: number; maxAssistantMessages: number; terminalReason: boolean },
): TrajectorySemanticStep {
  const selectedActions = new Map<string, TrajectoryToolAction>()
  for (const action of value.toolActions) {
    if (action.status !== 'completed' && selectedActions.size < options.maxToolActions) selectedActions.set(action.callId, action)
  }
  for (const action of options.maxToolActions === 0 ? [] : value.toolActions.slice(-options.maxToolActions)) {
    if (selectedActions.size < options.maxToolActions) selectedActions.set(action.callId, action)
  }
  const assistantMessages = (options.maxAssistantMessages === 0 ? [] : value.assistantMessages.slice(-options.maxAssistantMessages))
    .map(message => compactMessage(message, options.excerptBytes))
  const toolActions = [...selectedActions.values()].map(action => compactToolAction(action, options.excerptBytes))
  const selectedRequests = new Map<number, NonNullable<TrajectorySemanticStep['modelRequests']>[number]>()
  for (const request of value.modelRequests ?? []) {
    if (/error|failed|exception|retry/iu.test(JSON.stringify(request.finishReason ?? null)) && selectedRequests.size < 2) {
      selectedRequests.set(request.firstSeq, request)
    }
  }
  for (const request of (value.modelRequests ?? []).slice(-2)) {
    if (selectedRequests.size < 2) selectedRequests.set(request.firstSeq, request)
  }
  const modelRequests = [...selectedRequests.values()].sort((left, right) => left.firstSeq - right.firstSeq).map(request => ({
    ...request,
    ...(request.usage === undefined ? {} : {
      usage: compactJsonEvidence(request.usage, runId, 'modelRequest.usage', options.excerptBytes),
    }),
    ...(request.finishReason === undefined ? {} : {
      finishReason: compactJsonEvidence(request.finishReason, runId, 'modelRequest.finishReason', options.excerptBytes),
    }),
    ...(request.partial === undefined ? {} : {
      partial: { ...request.partial, content: compactExcerpt(request.partial.content, options.excerptBytes) },
    }),
  }))
  const { terminalReason, modelRequests: _modelRequests, ...base } = value
  return {
    ...base,
    id: boundedUtf8(value.id, 128),
    ...(value.contextEpochId === undefined ? {} : { contextEpochId: boundedUtf8(value.contextEpochId, 128) }),
    assistantMessages,
    toolActions,
    ...(modelRequests.length === 0 ? {} : { modelRequests }),
    ...(terminalReason === undefined || !options.terminalReason ? {} : {
      terminalReasonExcerpt: compactExcerpt(
        contentExcerpt(runId, terminalReason, 'step.terminalReason', value.seqEnd, options.excerptBytes),
        options.excerptBytes,
      ),
    }),
    ...(value.assistantMessages.length <= assistantMessages.length ? {} : {
      omittedAssistantMessageCount: value.assistantMessages.length - assistantMessages.length,
    }),
    ...(value.toolActions.length <= toolActions.length ? {} : {
      omittedToolActionCount: value.toolActions.length - toolActions.length,
    }),
    ...((value.modelRequests?.length ?? 0) <= modelRequests.length ? {} : {
      omittedModelRequestCount: value.modelRequests!.length - modelRequests.length,
    }),
  }
}

function compactEpoch(
  value: TrajectoryContextEpoch,
  runId: string,
  options: { excerptBytes: number; maxSurfaceSeqs: number },
): TrajectoryContextEpoch {
  const surfaceMessageSeqs = options.maxSurfaceSeqs === 0 ? [] : value.surfaceMessageSeqs.slice(-options.maxSurfaceSeqs)
  return {
    ...value,
    id: boundedUtf8(value.id, 128),
    header: {
      ...(value.header.config === undefined ? {} : {
        configExcerpt: compactExcerpt(
          contentExcerpt(runId, value.header.config, 'request.header.config', value.requestSeq, options.excerptBytes),
          options.excerptBytes,
        ),
      }),
      ...(value.header.adapterDefaults === undefined ? {} : {
        adapterDefaultsExcerpt: compactExcerpt(
          contentExcerpt(runId, value.header.adapterDefaults, 'request.header.adapterDefaults', value.requestSeq, options.excerptBytes),
          options.excerptBytes,
        ),
      }),
      ...(value.header.system === undefined ? {} : { system: compactExcerpt(value.header.system, options.excerptBytes) }),
      ...(value.header.tools === undefined ? {} : { tools: compactExcerpt(value.header.tools, options.excerptBytes) }),
    },
    surfaceMessageSeqs,
    ...(value.surfaceMessageSeqs.length <= surfaceMessageSeqs.length ? {} : {
      omittedSurfaceMessageSeqCount: value.surfaceMessageSeqs.length - surfaceMessageSeqs.length,
    }),
  }
}

function compactCounts(
  values: Readonly<Record<string, number>>,
  maxEntries: number,
): { counts: Record<string, number>; omittedCount: number } {
  const entries = Object.entries(values)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maxEntries)
    .map(([key, count]) => [boundedUtf8(key, 96), count] as const)
  return { counts: Object.fromEntries(entries), omittedCount: Object.keys(values).length - entries.length }
}

function compactJsonEvidence(
  value: JsonValue,
  runId: string,
  field: string,
  maxBytes: number,
): JsonValue {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value
  return {
    truncated: true,
    excerpt: compactExcerpt(contentExcerpt(runId, value, field, undefined, maxBytes), maxBytes),
  } as unknown as JsonValue
}

export class RefineCapabilities {
  private readonly maxReadBytes: number
  private readonly maxTrajectoryPageBytes: number
  private readonly secretValues: readonly string[]
  private readonly options: CapabilityOptions
  private readonly trajectoryProjections = new Map<string, SharedProjectionLoad>()
  private readonly trajectoryEvidenceBlockers = new Map<string, TrajectoryEvidenceBlocker>()
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
      if (method === 'refine.status') return this.service.status(this.string(args, 'evolutionId'), this.optionalString(args, 'roundId'))
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
      return publicJson({ ref: parentHarnessRef, digest: parentHarnessDigest, manifest })
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
      const requestedView = this.optionalString(args, 'view')
      if (requestedView !== undefined && !['bundle', 'steps', 'context', 'events'].includes(requestedView)) {
        throw new TypeError('trajectory view must be bundle, steps, context, or events')
      }
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? 20, 100)
      if (limit <= 0) throw new TypeError('limit must be a positive integer')
      const rounds = await store.listRounds()
      const evidence = baseline === undefined ? this.seedRunEvidence(rounds) : [
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
      const refs = this.optionalStrings(args, 'refs')
      const requestedRoundId = this.optionalString(args, 'roundId')
        ?? activeRoundId
      const visibleRounds = requestedRoundId === undefined
        ? rounds
        : rounds.filter(round => round.roundId === requestedRoundId)
      if (requestedRoundId !== undefined && visibleRounds.length === 0) {
        throw new Error(`unknown refinement round: ${requestedRoundId}`)
      }
      if (refs === undefined || refs.length === 0) {
        for (const round of visibleRounds.slice(offset, offset + limit)) {
          const visibleBaseline = round.roundId === activeRoundId ? baseline ?? round.baseline : round.baseline
          meta.recordEvidenceAccess(round.roundId, sessionId, {
            summary: visibleBaseline !== undefined,
            refs: visibleBaseline === undefined ? [] : [
              visibleBaseline.evalId,
              ...visibleBaseline.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
              ...visibleBaseline.invalidTrials.map(trial => trial.runId),
            ],
          })
        }
        const projected = visibleRounds.slice(offset, offset + limit).map(round => ({
          roundId: round.roundId,
          status: round.status,
          targetHarnessRef: round.roundId === activeRoundId ? parentHarnessRef ?? round.targetHarnessRef : round.targetHarnessRef,
          seedEvidence: [
            ...(round.roundId === activeRoundId && baseline !== undefined
              ? [this.projectEvidence('seed-baseline', baseline)]
              : round.baseline === undefined ? [] : [this.projectEvidence('seed-baseline', round.baseline)]),
            ...(round.roundId === activeRoundId && baseline !== undefined || round.evaluation?.seedCandidate === undefined
              ? [] : [this.projectEvidence('seed-candidate', round.evaluation.seedCandidate)]),
            ...(round.failedEvaluations ?? [])
              .filter(failed => failed.phase === 'seed-baseline' || failed.phase === 'seed-candidate')
              .map(failed => this.projectFailedEvidence(failed)),
          ],
          scoreDelta: round.evaluation?.scoreDelta,
          decision: round.decision,
          failure: round.failure === undefined ? undefined : { phase: round.failure.phase },
        }))
        const readiness = baseline === undefined
          ? undefined
          : finalizationReadiness(
              baseline,
              meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
              this.trajectoryBlockers(sessionId, activeRoundId, baseline),
            )
        return publicJson({
          rounds: projected,
          offset,
          limit,
          eof: offset + projected.length >= visibleRounds.length,
          ...(readiness === undefined ? {} : { diagnosisProgress: readiness }),
        })
      }
      if (refs.length > 10) throw new TypeError('trajectory.query accepts at most 10 refs')
      if (this.options.trajectoryReader === undefined) throw new Error('Hitch trajectory reader is unavailable')
      const selected = this.resolveSeedRefs(refs, evidence, requestedRoundId)
      const view = requestedView ?? 'bundle'
      if (selected.length > 10) {
        throw new TypeError('trajectory.query expands to at most 10 runs; query recorded run refs in batches')
      }
      if (view !== 'bundle' && selected.length !== 1) {
        throw new TypeError(`${view} drill-down requires exactly one recorded run ref`)
      }
      if (view === 'bundle') {
        const bundles: GearFailureBundle[] = []
        const receipts: Array<{ item: SeedRunEvidence; receipt: DiagnosisReceipt }> = []
        const totalBudget = this.options.maxFailureBundleBytes ?? this.maxTrajectoryPageBytes
        const perBundleBudget = Math.floor(totalBudget / Math.max(1, selected.length))
        if (perBundleBudget < 4 * 1024) {
          if (selected.length > 1) return publicJson(this.bundleBatchRecovery(selected))
          throw new Error('failure bundle output budget is too small for this batch; query fewer run refs')
        }
        try {
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
            if (!projection.messages.some(message => message.eventType === 'user/message' && message.role === 'user')) {
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
            const bundle = this.failureBundle(
              item,
              projection,
              verifier,
              roundHeldOutRef(rounds, item.roundId),
              perBundleBudget,
            )
            bundles.push(bundle)
            if (bundle.coverage.task === 'complete' && bundle.coverage.trajectory === 'complete'
              && (bundle.trajectory.semanticStepCount === 0 || bundle.trajectory.keySteps.length > 0)) {
              receipts.push({
                item,
                receipt: this.diagnosisReceipt(
                  bundle,
                  projection.trajectoryDigest,
                  verifier.verifier.status,
                ),
              })
            }
          }
        } catch (error) {
          if (selected.length > 1 && error instanceof Error
            && error.message.includes('exceeds the configured output budget')) {
            return publicJson(this.bundleBatchRecovery(selected))
          }
          if (selected.length === 1 && error instanceof Error
            && error.message.includes('exceeds the configured output budget')) {
            const item = selected[0]!
            const blocker = this.recordTrajectoryBlocker(
              sessionId,
              item.roundId,
              item.trial.runId,
              Object.assign(error, { code: 'gear_failure_bundle_overflow' }),
            )
            return publicJson(this.trajectoryEvidenceBlocked([blocker]))
          }
          throw error
        }
        for (const { item, receipt } of receipts) meta.recordEvidenceAccess(item.roundId, sessionId, {
          refs: [item.evalId, item.trial.runId],
          diagnosisReceipts: [receipt],
        })
        const readiness = baseline === undefined
          ? undefined
          : finalizationReadiness(
              baseline,
              meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
              this.trajectoryBlockers(sessionId, activeRoundId, baseline),
            )
        return publicJson({
          bundles,
          ...(readiness === undefined ? {} : { diagnosisProgress: readiness }),
        })
      }

      const trajectories: unknown[] = []
      for (const item of selected) {
        if (view === 'events') {
          const requestedTypes = this.optionalStrings(args, 'eventTypes')
          const aroundSeq = this.optionalInteger(args, 'aroundSeq')
          const radius = this.optionalInteger(args, 'radius') ?? 10
          const errorsOnly = this.optionalBoolean(args, 'errorsOnly') ?? false
          const seqStart = this.optionalInteger(args, 'seqStart')
          const seqEnd = this.optionalInteger(args, 'seqEnd')
          const field = this.optionalString(args, 'field')
          const cursor = this.optionalString(args, 'cursor')
          const requestedDigest = this.optionalString(args, 'canonicalSha256')
          if (offset !== 0) throw new TypeError('events view uses cursor pagination; offset must be 0')
          if (aroundSeq !== undefined && (seqStart !== undefined || seqEnd !== undefined || field !== undefined)) {
            throw new TypeError('aroundSeq cannot be combined with seqStart, seqEnd, or field')
          }
          if (radius < 0) throw new TypeError('radius must be non-negative')
          const projection = requestedDigest === undefined && cursor === undefined
            ? await this.projectedTrajectory(item.trial.runId, signal)
            : undefined
          const canonicalSha256 = requestedDigest ?? projection?.trajectoryDigest
          let pageLimit = limit
          let page
          let events
          let bounded
          while (true) {
            page = await this.options.trajectoryReader.inspectTrajectoryEvents(item.trial.runId, {
              ...(requestedTypes === undefined ? {} : { eventTypes: requestedTypes }),
              ...(aroundSeq === undefined ? (seqStart === undefined ? {} : { seqStart }) : { seqStart: Math.max(0, aroundSeq - radius) }),
              ...(aroundSeq === undefined ? (seqEnd === undefined ? {} : { seqEnd }) : { seqEnd: aroundSeq + radius }),
              ...(field === undefined ? {} : { field }),
              ...(canonicalSha256 === undefined ? {} : { canonicalSha256 }),
              ...(cursor === undefined ? {} : { cursor }),
              limit: pageLimit,
              maxBytes: this.maxTrajectoryPageBytes,
            }, signal)
            events = errorsOnly
              ? page.events.filter(event => /error|failed|exception|retry/iu.test(JSON.stringify(event)))
              : page.events
            bounded = this.boundTrajectoryItems(events, roundHeldOutRef(rounds, item.roundId))
            if (bounded.consumed === events.length) break
            if (pageLimit === 1) {
              throw Object.assign(new Error(`single bounded event for ${item.trial.runId} exceeds the Gear response budget`), {
                code: 'gear_trajectory_events_page_overflow',
              })
            }
            pageLimit = Math.max(1, Math.min(pageLimit - 1, bounded.consumed))
          }
          trajectories.push({
            ref: item.trial.runId,
            roundId: item.roundId,
            phase: item.phase,
            evalId: item.evalId,
            taskName: item.trial.taskName,
            trialName: item.trial.trialName,
            runId: page.runId,
            ...(item.failure === undefined ? {} : { outcome: 'failed', failure: item.failure }),
            view,
            canonicalSha256: page.canonicalSha256,
            filter: page.filter,
            events: bounded.items,
            cursor: cursor ?? null,
            limit: pageLimit,
            ...(pageLimit === limit ? {} : { requestedLimit: limit }),
            total: page.totalMatches,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            eof: page.eof,
            ...(page.redactions === undefined ? {} : { redactions: page.redactions }),
            ...(errorsOnly ? { pageFilter: 'errorsOnly' } : {}),
          })
          continue
        }
        const projection = await this.projectedTrajectory(item.trial.runId, signal)
        if (view === 'steps') {
          const turn = this.optionalInteger(args, 'turn')
          const stepNumber = this.optionalInteger(args, 'step')
          const errorsOnly = this.optionalBoolean(args, 'errorsOnly') ?? false
          const filtered = projection.semanticSteps.filter(step =>
            (turn === undefined || step.turn === turn)
            && (stepNumber === undefined || step.step === stepNumber)
            && (!errorsOnly || step.toolActions.some(action => action.status !== 'completed')))
          const page = filtered.slice(offset, offset + limit)
          const bounded = this.boundTrajectoryItems(page, roundHeldOutRef(rounds, item.roundId))
          trajectories.push({
            ref: item.trial.runId,
            roundId: item.roundId,
            phase: item.phase,
            evalId: item.evalId,
            taskName: item.trial.taskName,
            runId: item.trial.runId,
            view,
            steps: bounded.items,
            offset,
            limit,
            total: filtered.length,
            nextOffset: offset + bounded.consumed,
            eof: offset + bounded.consumed >= filtered.length && bounded.consumed === page.length,
          })
          continue
        }
        if (view === 'context') {
          const epochs = projection.contextEpochs.slice(offset, offset + limit)
          const contexts = epochs.map(epoch => {
            const surfaceMessages = epoch.surfaceMessageSeqs
              .flatMap(seq => projection.messages.find(message => message.seq === seq) ?? [])
            const visibleMessages = surfaceMessages.slice(-6)
            return {
              ...epoch,
              surfaceMessageCount: surfaceMessages.length,
              omittedSurfaceMessageCount: surfaceMessages.length - visibleMessages.length,
              surfaceMessages: visibleMessages,
            }
          })
          const bounded = this.boundTrajectoryItems(contexts, roundHeldOutRef(rounds, item.roundId))
          trajectories.push({
            ref: item.trial.runId,
            roundId: item.roundId,
            phase: item.phase,
            evalId: item.evalId,
            taskName: item.trial.taskName,
            runId: item.trial.runId,
            view,
            epochs: bounded.items,
            offset,
            limit,
            total: projection.contextEpochs.length,
            nextOffset: offset + bounded.consumed,
            eof: offset + bounded.consumed >= projection.contextEpochs.length && bounded.consumed === epochs.length,
          })
          continue
        }
      }
      for (const item of selected) meta.recordEvidenceAccess(item.roundId, sessionId, {
        refs: [item.evalId, item.trial.runId],
      })
      return publicJson({ trajectories })
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
      return visibleStatus
    }
    if (method === 'candidate.diff') {
      return publicJson(await this.service.workspaceManager.diff(workspace.workspaceId, this.optionalInteger(args, 'maxBytes'), signal))
    }
    if (method === 'candidate.check') {
      const check = this.optionalString(args, 'check')
      if (check !== undefined && check !== 'compiler') throw new TypeError('candidate_check only supports the fixed "compiler" pipeline')
      await this.service.workspaceManager.withOpenWorkspace(sessionId, true, async handle => this.builder.checkWorkspace(handle, signal))
      const summary = await this.service.workspaceManager.preflight(workspace.workspaceId, signal)
      const readiness = baseline === undefined
        ? undefined
        : finalizationReadiness(
            baseline,
            meta.proposalEvidenceAudit(activeRoundId, sessionId, []),
            this.trajectoryBlockers(sessionId, activeRoundId, baseline),
          )
      return {
        ok: true,
        summary,
        compiler: { ok: true, summary },
        ...(readiness === undefined ? {} : { finalizationReadiness: readiness }),
      }
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
      bundles: [],
      batchAccepted: false,
      recoverable: false,
      code: 'TRAJECTORY_EVIDENCE_UNAVAILABLE',
      message: `Failure bundles could not be constructed for ${blockers.length} run${blockers.length === 1 ? '' : 's'}. Do not retry the same query until Hitch or the trajectory evidence is repaired.`,
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
        if (evidence.parent.evalId !== item.evalId) {
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

  private bundleBatchRecovery(selected: readonly SeedRunEvidence[]): Record<string, unknown> {
    const actions = selected.map((item, index) => ({
      actionId: `diagnose-oversized-bundle-${index + 1}`,
      tool: 'trajectory_query',
      arguments: { refs: [item.trial.runId], view: 'bundle' },
      reason: `Read the failure bundle for recorded run ${item.trial.runId} separately because the combined response exceeds the output budget.`,
      coversRunIds: [item.trial.runId],
    }))
    return {
      schemaVersion: 1,
      bundles: [],
      batchAccepted: false,
      recoverable: true,
      code: 'BUNDLE_BATCH_TOO_LARGE',
      message: 'The combined failure-bundle response exceeds the output budget. Execute nextAction, then remainingActions; each successful single-run query records its diagnosis receipt.',
      nextAction: actions[0],
      remainingActions: actions.slice(1),
    }
  }

  private failureBundle(
    item: SeedRunEvidence,
    projection: TrajectoryProjection,
    verifierEvidence: HitchVerifierEvidence,
    heldOutRef: string | undefined,
    maxBytes: number,
  ): GearFailureBundle {
    const reward = item.trial.rewards?.reward ?? Object.values(item.trial.rewards ?? {})[0]
    const prompt = projection.messages.find(message => message.eventType === 'user/message' && message.role === 'user')
    const workspaceStatus = projection.pathsObservedThroughTools.length === 0 ? 'missing' : 'observed-only'
    const minimumSteps = projection.semanticSteps.length === 0 ? 0 : 1
    const profiles = [
      {
        maxSteps: 8, excerptBytes: 1_200, maxToolActions: 2, maxAssistantMessages: 1,
        terminalReason: true, maxContexts: 4, maxSurfaceSeqs: 32, maxPaths: 16,
        pathBytes: 256, maxEventTypes: 32, maxErrors: 8, labelBytes: 512, includeFinalAnswer: true,
        verifierBytes: 12 * 1024,
      },
      {
        maxSteps: 2, excerptBytes: 320, maxToolActions: 1, maxAssistantMessages: 1,
        terminalReason: false, maxContexts: 1, maxSurfaceSeqs: 8, maxPaths: 4,
        pathBytes: 96, maxEventTypes: 8, maxErrors: 3, labelBytes: 128, includeFinalAnswer: true,
        verifierBytes: 2 * 1024,
      },
      {
        maxSteps: 1, excerptBytes: 220, maxToolActions: 1, maxAssistantMessages: 1,
        terminalReason: false, maxContexts: 0, maxSurfaceSeqs: 0, maxPaths: 0,
        pathBytes: 0, maxEventTypes: 0, maxErrors: 1, labelBytes: 96, includeFinalAnswer: false,
        verifierBytes: 1_024,
      },
    ] as const
    for (const profile of profiles) {
      const upperSteps = Math.min(profile.maxSteps, projection.semanticSteps.length)
      for (let maxSteps = upperSteps; maxSteps >= minimumSteps; maxSteps -= 1) {
        const selectedSteps = selectKeySteps(projection, maxSteps)
        const keySteps = selectedSteps.map(step => compactStep(step, item.trial.runId, {
          excerptBytes: profile.excerptBytes,
          maxToolActions: profile.maxToolActions,
          maxAssistantMessages: profile.maxContexts === 0 && step.toolActions.length > 0
            ? 0
            : profile.maxAssistantMessages,
          terminalReason: profile.terminalReason,
        }))
        const contextIds = new Set(keySteps.flatMap(step => step.contextEpochId === undefined ? [] : [step.contextEpochId]))
        const selectedContexts = contextIds.size > 0
          ? projection.contextEpochs.filter(epoch => contextIds.has(epoch.id))
          : projection.contextEpochs.filter((_epoch, index) => index === 0 || index === projection.contextEpochs.length - 1)
        const contextEpochs = (profile.maxContexts === 0 ? [] : selectedContexts.slice(-profile.maxContexts))
          .map(epoch => compactEpoch(epoch, item.trial.runId, {
            excerptBytes: profile.excerptBytes,
            maxSurfaceSeqs: profile.maxSurfaceSeqs,
          }))
        const eventTypes = compactCounts(projection.omittedEventTypes, profile.maxEventTypes)
        const pathsObservedThroughTools = projection.pathsObservedThroughTools
          .slice(0, profile.maxPaths)
          .map(path => boundedUtf8(path, profile.pathBytes))
        const errors = projection.errors.slice(0, profile.maxErrors).map(error => ({
          ...(error.seq === undefined ? {} : { seq: error.seq }),
          type: boundedUtf8(error.type, 128),
          excerpt: boundedUtf8(error.excerpt, profile.excerptBytes),
        }))
        const taskName = boundedUtf8(item.trial.taskName, profile.labelBytes)
        const trialName = item.trial.trialName === undefined
          ? undefined
          : boundedUtf8(item.trial.trialName, profile.labelBytes)
        const crossSourceSignals: GearFailureBundle['crossSourceSignals'] = []
        if (item.trial.status === 'completed' && (reward ?? 0) <= 0) {
          crossSourceSignals.push({ kind: 'completed_run_with_zero_reward', runId: item.trial.runId })
        }
        if (projection.errors.length > 0) {
          crossSourceSignals.push({ kind: 'completed_run_with_tool_errors', runId: item.trial.runId })
        }
        if (workspaceStatus === 'observed-only') {
          crossSourceSignals.push({ kind: 'workspace_paths_observed_without_authoritative_diff', runId: item.trial.runId })
        }
        const verifierStatus = verifierEvidence.verifier.status === 'corrupt'
          ? 'unavailable' as const
          : verifierEvidence.verifier.status
        const verifierCoverage = verifierStatus === 'missing'
          ? 'explicitly-missing' as const
          : verifierStatus
        if (verifierEvidence.verifier.status === 'unavailable') {
          crossSourceSignals.push({ kind: 'verifier_evidence_unavailable', runId: item.trial.runId })
        } else if (verifierEvidence.verifier.status === 'corrupt') {
          crossSourceSignals.push({ kind: 'verifier_evidence_corrupt', runId: item.trial.runId })
        } else if (verifierEvidence.verifier.status === 'result_only') {
          crossSourceSignals.push({ kind: 'verifier_diagnostics_missing', runId: item.trial.runId })
        } else if (verifierEvidence.verifier.status === 'missing') {
          crossSourceSignals.push({ kind: 'verifier_result_explicitly_missing', runId: item.trial.runId })
        }
        if (reward !== undefined && verifierEvidence.observation?.reward !== undefined
          && reward !== verifierEvidence.observation.reward) {
          crossSourceSignals.push({ kind: 'baseline_verifier_reward_mismatch', runId: item.trial.runId })
        }
        const verifierDiagnostics = {
          ...(verifierEvidence.verifier.diagnostics === undefined
            ? {}
            : { artifacts: verifierEvidence.verifier.diagnostics }),
          ...(verifierEvidence.verifier.issues === undefined ? {} : { issues: verifierEvidence.verifier.issues }),
          ...(verifierEvidence.redactions === undefined ? {} : { redactions: verifierEvidence.redactions }),
        }
        const hasVerifierDiagnostics = Object.keys(verifierDiagnostics).length > 0
        // Sanitize structured evidence before it can be collapsed into a text
        // excerpt. Once serialized, key-sensitive values can no longer be
        // recognized by the sanitizer.
        const safeVerifierResult = verifierEvidence.verifier.result === undefined
          ? undefined
          : publicJson(this.sanitize(verifierEvidence.verifier.result, heldOutRef))
        const safeVerifierDiagnostics = !hasVerifierDiagnostics
          ? undefined
          : publicJson(this.sanitize(verifierDiagnostics, heldOutRef))
        const draft = {
          schemaVersion: 1 as const,
          identity: {
            evolutionId: item.evolutionId,
            roundId: item.roundId,
            phase: item.phase,
            evalId: item.evalId,
            runId: item.trial.runId,
            taskName,
            ...(taskName === item.trial.taskName ? {} : { taskNameTruncated: true }),
            ...(trialName === undefined ? {} : { trialName }),
            ...(trialName === item.trial.trialName ? {} : { trialNameTruncated: true }),
            ...(item.trial.attempt === undefined ? {} : { attempt: item.trial.attempt }),
            trajectoryDigest: projection.trajectoryDigest,
          },
          task: prompt === undefined ? {} : { prompt: compactExcerpt(prompt.message, profile.excerptBytes) },
          outcome: {
            trialStatus: item.trial.status,
            ...(reward === undefined ? {} : { reward }),
            ...(item.trial.invalidReason === undefined ? {} : {
              invalidReason: boundedUtf8(item.trial.invalidReason, profile.labelBytes),
            }),
            verifierStatus,
            ...(safeVerifierResult === undefined ? {} : {
              verifierResult: compactJsonEvidence(
                safeVerifierResult,
                item.trial.runId,
                'verifier.result',
                profile.verifierBytes,
              ),
            }),
            ...(safeVerifierDiagnostics === undefined ? {} : {
              verifierDiagnostics: compactJsonEvidence(
                safeVerifierDiagnostics,
                item.trial.runId,
                'verifier.diagnostics',
                profile.verifierBytes,
              ),
            }),
          },
          trajectory: {
            fidelity: projection.fidelity,
            rawEventCount: projection.rawEventCount,
            omittedEventTypes: eventTypes.counts,
            ...(eventTypes.omittedCount === 0 ? {} : { omittedEventTypeCount: eventTypes.omittedCount }),
            contextEpochCount: projection.contextEpochs.length,
            contextEpochs,
            semanticStepCount: projection.semanticSteps.length,
            keySteps,
            omittedStepCount: projection.semanticSteps.length - keySteps.length,
            errors,
            ...(projection.errors.length <= errors.length ? {} : {
              omittedErrorCount: projection.errors.length - errors.length,
            }),
            ...(projection.finalAnswer === undefined || !profile.includeFinalAnswer
              ? {}
              : { finalAnswer: compactMessage(projection.finalAnswer, profile.excerptBytes) }),
          },
          workspace: {
            status: workspaceStatus,
            pathsObservedThroughTools,
            ...(projection.pathsObservedThroughTools.length <= pathsObservedThroughTools.length ? {} : {
              omittedPathCount: projection.pathsObservedThroughTools.length - pathsObservedThroughTools.length,
            }),
          },
          crossSourceSignals,
          coverage: {
            task: prompt === undefined ? 'missing' as const : 'complete' as const,
            trajectory: projection.coverage.surface === 'complete' && projection.fidelity !== 'unavailable'
              ? 'complete' as const
              : 'partial' as const,
            content: projection.coverage.content,
            verifier: verifierCoverage,
            childSessions: projection.coverage.childSessions,
            workspace: workspaceStatus,
          },
        }
        // publicJson is part of the externally visible projection, so apply it
        // before binding the bundle digest and recording a diagnosis receipt.
        const sanitized = publicJson(this.sanitize(draft, heldOutRef)) as unknown as Omit<GearFailureBundle, 'bundleDigest'>
        const bundle: GearFailureBundle = { ...sanitized, bundleDigest: digestJson(sanitized) }
        if (Buffer.byteLength(JSON.stringify(bundle)) <= maxBytes) return bundle
      }
    }
    throw new Error(`failure bundle for ${item.trial.runId} exceeds the configured output budget`)
  }

  private diagnosisReceipt(
    bundle: GearFailureBundle,
    trajectoryDigest: string,
    sourceVerifierStatus: HitchVerifierEvidence['verifier']['status'],
  ): DiagnosisReceipt {
    return {
      runId: bundle.identity.runId,
      bundleDigest: bundle.bundleDigest,
      trajectoryDigest,
      projectionVersion: 1,
      verifierStatus: bundle.coverage.verifier,
      ...(bundle.coverage.verifier === 'unavailable' && sourceVerifierStatus === 'unavailable'
        && this.options.allowUnavailableVerifierDiagnosis === true
        ? { compatibility: 'allow-unavailable-verifier' as const }
        : {}),
      sanitizationPolicyDigest: digestJson({
        sensitiveKeyPattern: SENSITIVE_KEY.source,
        secretDigests: this.secretValues.map(value => digestJson(value)).sort(),
      }),
      inspectedAt: new Date().toISOString(),
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
        && (item.evalId === ref || item.trial.runId === ref))
      if (matches.length === 0) throw new Error(`trajectory ref is not recorded seed evidence: ${ref}`)
      for (const item of matches) selected.set(item.trial.runId, item)
    }
    return [...selected.values()]
  }

  private projectEvidence(phase: SeedRunEvidence['phase'], evidence: EvaluationEvidence): unknown {
    const trials: SeedRunEvidence['trial'][] = [
      ...evidence.trials.flatMap(trial => trial.runId === undefined ? [] : [{ ...trial, runId: trial.runId }]),
      ...evidence.invalidTrials.map(trial => ({ ...trial })),
    ]
    return {
      phase,
      evalId: evidence.evalId,
      harnessRef: evidence.actualCommit,
      completeness: evidence.completeness,
      plannedTrialCount: evidence.plannedTrialCount,
      primaryReward: evidence.primaryReward,
      summary: evidence.summary,
      trials,
      failedTrials: trials.filter(trial => trial.status === 'errored'
        || ((trial.rewards?.reward ?? Object.values(trial.rewards ?? {})[0] ?? 0) <= 0)),
    }
  }

  private projectFailedEvidence(
    failed: NonNullable<RefinementRound['failedEvaluations']>[number],
  ): unknown {
    return {
      phase: failed.phase,
      outcome: 'failed',
      evalId: failed.evidence.evalId,
      harnessRef: failed.evidence.actualCommit,
      owner: failed.owner,
      failure: failed.failure,
      trials: failed.evidence.trials,
      failedTrials: failed.evidence.trials.filter(trial => trial.status === 'errored'),
    }
  }

  private boundTrajectoryItems(items: unknown[], heldOutRef: string | undefined): {
    items: JsonValue[]
    consumed: number
  } {
    const bounded: JsonValue[] = []
    let bytes = 0
    let consumed = 0
    for (const item of items) {
      let sanitized = this.sanitize(item, heldOutRef)
      let itemBytes = Buffer.byteLength(JSON.stringify(sanitized))
      if (itemBytes > this.maxTrajectoryPageBytes) {
        const source = record(item)
        sanitized = this.sanitize({
          ...(typeof source.id === 'string' ? { id: source.id } : {}),
          ...(typeof source.type === 'string' ? { type: source.type } : {}),
          ...(typeof source.seq === 'number' ? { seq: source.seq } : {}),
          ...(typeof source.requestSeq === 'number' ? { requestSeq: source.requestSeq } : {}),
          ...(typeof source.boundarySeq === 'number' ? { boundarySeq: source.boundarySeq } : {}),
          ...(typeof source.seqStart === 'number' ? { seqStart: source.seqStart } : {}),
          ...(typeof source.turn === 'number' ? { turn: source.turn } : {}),
          ...(typeof source.step === 'number' ? { step: source.step } : {}),
          truncated: true,
          originalBytes: itemBytes,
        }, heldOutRef)
        itemBytes = Buffer.byteLength(JSON.stringify(sanitized))
      }
      if (bounded.length > 0 && bytes + itemBytes > this.maxTrajectoryPageBytes) break
      bounded.push(sanitized)
      bytes += itemBytes
      consumed += 1
    }
    return { items: bounded, consumed }
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
