import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvolutionRegistryStore } from '../../state/evolution.js';
import { digestJson } from '../../state/digest.js';
import { digestDatasetRef } from '../../state/dataset.js';
import { describeDataset } from '../../search/dataset-projection.js';
import type { EvaluationEvidence, HitchTrajectoryReader, RefinementRound } from '../../types.js';
import { sanitizePublicValue } from '../../meta/sanitize.js';
import { canonicalJson, jsonDigest } from '../schema.js';
import { validateSelector, type ExperiencePurpose, type ExperienceSourceAuthority, type SourceExperience, type SourceGrant,
  type SourceSelector, type SourceSnapshot } from './experience.js';

export type HistoricalSeedSourceOptions = {
  registry: EvolutionRegistryStore;
  evolutionId: string;
  roundId: string;
  workspaceRoot: string;
  authorityId: string;
  /** Exact seed evaluation already saved in the validated round; omit for task-only history. */
  evaluationId?: string;
  trajectoryReader?: HitchTrajectoryReader;
  maxTasks?: number;
  maxTraceNodes?: number;
};

function seedEvaluations(round: RefinementRound): EvaluationEvidence[] {
  const found = [round.baseline, ...(round.parentBaselines?.map(item => item.evidence) ?? []),
    ...round.candidatePool.map(item => item.seedEvaluation), round.evaluation?.seedBaseline, round.evaluation?.seedCandidate]
    .filter((value): value is EvaluationEvidence => value !== undefined);
  const byId = new Map<string, EvaluationEvidence>();
  for (const item of found) {
    const prior = byId.get(item.evalId);
    if (prior && canonicalJson(prior) !== canonicalJson(item)) throw new Error('Conflicting historical seed evaluation identity');
    byId.set(item.evalId, item);
  }
  return [...byId.values()];
}

const EVENT_TYPES = ['assistant/message', 'tool/error', 'tool/result', 'user/message'];
const PRIVATE_KEY = /(?:grader|label|reward|score|verifier|held.?out)/iu;
function researchProjection(value: unknown, heldOutRef: string, key?: string): unknown {
  if (key && PRIVATE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => researchProjection(item, heldOutRef));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) =>
    [name, researchProjection(item, heldOutRef, name)]));
  return sanitizePublicValue(value, heldOutRef, [], key);
}

function fragments(text: string, maxBytes = 12 * 1024): string[] {
  const parts: string[] = [];
  let current = '', bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) { parts.push(current); current = ''; bytes = 0; }
    current += point; bytes += size;
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

async function expandExcerpt(value: unknown, reader: HitchTrajectoryReader, runId: string,
  canonicalSha256: string, budget: { details: number }, depth = 0): Promise<unknown> {
  if (depth > 8) throw new Error('Historical trajectory excerpt nesting too deep');
  if (Array.isArray(value)) return Promise.all(value.map(item => expandExcerpt(item, reader, runId, canonicalSha256, budget, depth + 1)));
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  const source = item.source as { runId?: string; seq?: number; field?: string } | undefined;
  if (item.truncated === true && typeof item.preview === 'string' && source) {
    if (source.runId !== runId || !Number.isSafeInteger(source.seq) || typeof source.field !== 'string'
      || ++budget.details > 100) throw new Error('Historical trajectory excerpt source invalid or too large');
    const seq = source.seq as number;
    const page = await reader.inspectTrajectoryEvents(runId, { seqStart: seq, seqEnd: seq,
      field: source.field, canonicalSha256, limit: 1, maxBytes: 256 * 1024 }, new AbortController().signal);
    const fieldEvent = page.events[0] as Record<string, unknown> | undefined;
    const nested = fieldEvent?.event_excerpt as Record<string, unknown> | undefined;
    const full = fieldEvent && Object.hasOwn(fieldEvent, 'value') ? fieldEvent.value : nested?.value;
    if (page.runId !== runId || page.canonicalSha256 !== canonicalSha256 || page.filter.seqStart !== seq
      || page.filter.seqEnd !== seq || page.filter.field !== source.field || page.events.length !== 1
      || full === undefined) throw new Error('Historical trajectory field is unavailable or changed');
    return expandExcerpt(full, reader, runId, canonicalSha256, budget, depth + 1);
  }
  return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, child]) =>
    [key, await expandExcerpt(child, reader, runId, canonicalSha256, budget, depth + 1)])));
}

async function projectedEvents(reader: HitchTrajectoryReader, runId: string, canonicalSha256: string,
  heldOutRef: string, maxNodes: number, analysisRedactions: unknown): Promise<string[]> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const result: string[] = [];
  let expectedMatches: number | undefined;
  let seenEvents = 0, totalBytes = 0;
  const pageRedactions: unknown[] = [];
  const detailBudget = { details: 0 };
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const page = await reader.inspectTrajectoryEvents(runId, { eventTypes: EVENT_TYPES, canonicalSha256,
      ...(cursor ? { cursor } : {}), limit: 100, maxBytes: 256 * 1024 }, new AbortController().signal);
    if (page.runId !== runId || page.canonicalSha256 !== canonicalSha256 || page.kind !== 'trajectory-events-page'
      || page.filter.eventTypes?.join('\0') !== EVENT_TYPES.join('\0')
      || expectedMatches !== undefined && page.totalMatches !== expectedMatches) throw new Error('Historical trajectory page identity drift');
    expectedMatches = page.totalMatches;
    if (page.redactions?.length) pageRedactions.push({ pageIndex, redactions: page.redactions });
    for (const event of page.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || !EVENT_TYPES.includes(String(event.type)) || !Number.isSafeInteger(event.seq))
        throw new Error('Historical trajectory page is incomplete or invalid');
      const expanded = await expandExcerpt(event, reader, runId, canonicalSha256, detailBudget);
      if (Object.hasOwn(expanded as object, 'event_excerpt')) throw new Error('Historical trajectory event excerpt cannot be reconstructed');
      const safe = researchProjection(expanded, heldOutRef);
      const payload = canonicalJson(safe);
      totalBytes += Buffer.byteLength(payload);
      if (totalBytes > 2 * 1024 * 1024) throw new Error('Historical trajectory projection exceeds byte limit');
      const parts = fragments(payload);
      for (const [partIndex, content] of parts.entries()) {
        result.push(canonicalJson({ runId, canonicalSha256, eventSeq: event.seq,
          partIndex, partCount: parts.length, content }));
        if (result.length + 1 > maxNodes) throw new Error('Historical trajectory projection too large');
      }
      seenEvents++;
    }
    if (page.eof) {
      if (page.nextCursor || seenEvents !== expectedMatches) throw new Error('Historical trajectory page did not cover selected events');
      return [canonicalJson({ kind: 'trajectory-projection-receipt', runId, canonicalSha256,
        analysisRedactions: analysisRedactions ?? [], pageRedactions, selectedEventCount: seenEvents }), ...result];
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) throw new Error('Historical trajectory cursor did not advance');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Historical trajectory requires too many pages');
}

/** Reads verified local seed task directories and real bounded Hitch projections; never synthesizes tasks or traces. */
export class HistoricalSeedExperienceSource implements ExperienceSourceAuthority {
  constructor(readonly options: HistoricalSeedSourceOptions) {
    if (!options.authorityId || !options.evolutionId || !options.roundId || !options.workspaceRoot) throw new Error('Historical source host identity required');
    if (options.evaluationId && !options.trajectoryReader) throw new Error('Historical evaluation requires a physical trajectory reader');
  }

  private async capture(): Promise<SourceSnapshot> {
    const { registry, evolutionId, roundId, workspaceRoot, evaluationId, trajectoryReader } = this.options;
    const spec = await registry.requireSpec(evolutionId);
    const entry = await registry.readEntry(evolutionId);
    if (!entry || entry.specDigest !== digestJson(spec)) throw new Error('Historical evolution registry identity mismatch');
    const round = await registry.stateStore(evolutionId).readRound(roundId);
    if (!round || round.evolutionId !== evolutionId || round.seedTaskRef !== spec.datasets.seed.ref
      || round.plan.seed.dataset.digest !== spec.datasets.seed.digest || round.plan.seed.partition !== 'seed') throw new Error('Historical seed round/spec identity mismatch');
    const description = await describeDataset(spec, 'seed', workspaceRoot);
    if (description.sourceDigest !== spec.datasets.seed.digest || description.universe.tasks.length > (this.options.maxTasks ?? 1_000)) throw new Error('Historical seed dataset unavailable or too large');
    const evaluation = evaluationId ? seedEvaluations(round).find(item => item.evalId === evaluationId) : undefined;
    if (evaluationId && (!evaluation || evaluation.dataset !== spec.datasets.seed.ref || evaluation.conditionId !== round.plan.seed.conditionId
      || evaluation.requestedCommit !== evaluation.actualCommit)) throw new Error('Historical seed evaluation identity mismatch');
    if (evaluation) {
      const capabilities = await trajectoryReader!.inspectCapabilities(new AbortController().signal);
      if (capabilities.trajectoryAnalysis !== 1 || capabilities.trajectoryEventsPage !== 1) throw new Error('Hitch bounded trajectory capability unavailable');
    }
    const trials = new Map<string, string[]>();
    for (const trial of evaluation?.trials ?? []) {
      if (!description.universe.tasks.some(task => task.id === trial.taskName) || !trial.runId || !/^run_[0-9a-f]{32}$/u.test(trial.runId)) throw new Error('Historical trial has no verified physical run');
      trials.set(trial.taskName, [...trials.get(trial.taskName) ?? [], trial.runId]);
    }
    const entries: SourceExperience[] = [];
    let totalNodes = 0;
    for (const item of description.universe.tasks) {
      const instructionPath = join(description.root, item.id, 'instruction.md');
      const stat = await lstat(instructionPath).catch(() => { throw new Error(`Historical task instruction unavailable: ${item.id}`); });
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`Historical task instruction invalid: ${item.id}`);
      const prompt = await readFile(instructionPath, 'utf8');
      // The task report is the authorized research projection. Keep its real
      // instruction while removing the round's held-out path before sealing.
      const projectedPrompt = sanitizePublicValue(prompt, round.heldOutRef, []);
      if (typeof projectedPrompt !== 'string') throw new Error(`Historical task instruction projection invalid: ${item.id}`);
      const traceChunks: Array<{ sequence: number; text: string }> = [];
      for (const runId of trials.get(item.id) ?? []) {
        const analysis = await trajectoryReader!.inspectTrajectoryAnalysis(runId, new AbortController().signal);
        if (analysis.runId !== runId || !/^sha256:[0-9a-f]{64}$/u.test(analysis.source.canonicalSha256)
          || analysis.coverage.surface !== 'complete') throw new Error('Historical trajectory identity or coverage invalid');
        const events = await projectedEvents(trajectoryReader!, runId, analysis.source.canonicalSha256, round.heldOutRef,
          (this.options.maxTraceNodes ?? 1_000) - totalNodes, analysis.redactions);
        for (const text of events) {
          if (++totalNodes > (this.options.maxTraceNodes ?? 1_000)) throw new Error('Historical trajectory projection too large');
          traceChunks.push({ sequence: traceChunks.length, text });
        }
      }
      entries.push({ id: item.id, kind: 'task-trajectory', taskId: item.id,
        exposure: { seenInTraining: true, graderLabelExposed: false }, task: { prompt: projectedPrompt,
          executionSource: { kind: 'compiled-seed-dataset', datasetDigest: description.sourceDigest,
            taskContentDigest: item.contentDigest } },
        overview: { summary: `Verified seed task ${item.id}; ${trials.get(item.id)?.length ?? 0} physical run(s)`, tags: ['seed-task'] },
        taskReport: { narrative: `Seed dataset task ${item.id}, content digest ${item.contentDigest}; evaluation ${evaluationId ?? 'none'}.\nInstruction:\n${projectedPrompt}` }, traceChunks });
    }
    if (await digestDatasetRef(description.root) !== description.sourceDigest) throw new Error('Historical seed dataset changed during capture');
    const sourceManifestDigest = jsonDigest({ spec: digestJson(spec), round: digestJson(round), dataset: description.sourceDigest,
      evaluation: evaluation ? digestJson(evaluation) : null, entries });
    const selector: SourceSelector = { namespace: 'legacy-evolution', sourceId: evolutionId,
      cursor: { namespace: `legacy-evolution:${evolutionId}`, value: sourceManifestDigest } };
    validateSelector(selector);
    return { selector, sourceManifestDigest, indexVersion: 'historical-seed-physical-v1', provenance: 'verified', entries };
  }

  async selector(): Promise<SourceSelector> { return (await this.capture()).selector; }
  async resolve(selector: SourceSelector, purpose: ExperiencePurpose): Promise<{ snapshot: SourceSnapshot; grant: SourceGrant }> {
    const snapshot = await this.capture();
    if (canonicalJson(snapshot.selector) !== canonicalJson(selector)) throw new Error('Historical seed source cursor changed');
    return { snapshot, grant: { purpose, authorityId: this.options.authorityId,
      projections: this.options.evaluationId ? ['overview', 'task-report', 'trace-chunk'] : ['overview', 'task-report'], exposeGraderLabels: false } };
  }
}
