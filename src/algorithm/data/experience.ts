import type { ArtifactRef } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { assertDigest } from '../artifacts.js';
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js';

export type ExperienceNamespace = 'deployment' | 'legacy-evolution' | 'campaign' | 'import';
export type SourceCursor = { namespace: string; value: string };
export type ExperienceProjection = 'overview' | 'task-report' | 'trace-chunk';
export type ExperiencePurpose = 'research' | 'evaluation';
export type SourceSelector = { namespace: ExperienceNamespace; sourceId: string; cursor: SourceCursor };

/** Raw input is delivered by a host-registered authority, never loaded from an author-supplied path. */
export type SourceExperience = {
  id: string;
  /** Seed summaries are not runnable tasks and contain no physical trace. */
  kind?: 'task-trajectory' | 'seed-summary';
  taskId?: string;
  exposure: { seenInTraining: boolean; graderLabelExposed: boolean };
  task?: { prompt: string; executionSource?: { kind: 'compiled-seed-dataset'; datasetDigest: string; taskContentDigest: string } };
  overview: { summary: string; tags: string[] };
  taskReport: { narrative: string; outcomeSummary?: string };
  traceChunks: Array<{ text: string; sequence: number }>;
  grader?: { trueLabel: JsonValue; privateFeedback?: JsonValue };
};
export type SourceSnapshot = {
  selector: SourceSelector;
  /** Digest of the source system's sealed snapshot; source bytes stay with its authority. */
  sourceManifestDigest: string;
  indexVersion: string;
  entries: SourceExperience[];
  provenance: 'verified' | 'unverified';
};
export type SourceGrant = {
  purpose: ExperiencePurpose;
  projections: ExperienceProjection[];
  exposeGraderLabels: boolean;
  authorityId: string;
};
export interface ExperienceSourceAuthority {
  /** Must verify source identity, snapshot/cursor and caller authorization against its own source system. */
  resolve(selector: SourceSelector, purpose: ExperiencePurpose): Promise<{ snapshot: SourceSnapshot; grant: SourceGrant }>;
}

/** Registration is a host capability. Algorithm configuration only carries SourceSelector. */
export class AuthorizedExperienceSources implements ExperienceSourceAuthority {
  private readonly snapshots = new Map<string, { snapshot: SourceSnapshot; grant: SourceGrant }>();
  private key(selector: SourceSelector, purpose: ExperiencePurpose): string { return canonicalJson({ selector, purpose }); }
  registerVerified(snapshot: SourceSnapshot, grant: SourceGrant, verify: (snapshot: SourceSnapshot) => void): void {
    if (snapshot.selector.namespace === 'import' || snapshot.provenance !== 'verified') throw new Error('Verified source requires an original namespace');
    validateSelector(snapshot.selector); assertDigest(snapshot.sourceManifestDigest);
    verify(snapshot);
    this.register(snapshot, grant);
  }
  registerImport(snapshot: SourceSnapshot, grant: SourceGrant): void {
    if (snapshot.selector.namespace !== 'import' || snapshot.provenance !== 'unverified') throw new Error('Imported manifest must retain unverified provenance');
    validateSelector(snapshot.selector); assertDigest(snapshot.sourceManifestDigest);
    this.register(snapshot, grant);
  }
  private register(snapshot: SourceSnapshot, grant: SourceGrant): void {
    if (!grant.authorityId || !['research', 'evaluation'].includes(grant.purpose)) throw new Error('Source authorization required');
    const key = this.key(snapshot.selector, grant.purpose);
    if (this.snapshots.has(key)) throw new Error('Source snapshot already registered');
    assertJson(snapshot); assertJson(grant);
    this.snapshots.set(key, structuredClone({ snapshot, grant }));
  }
  resolve(selector: SourceSelector, purpose: ExperiencePurpose): Promise<{ snapshot: SourceSnapshot; grant: SourceGrant }> {
    validateSelector(selector);
    const registered = this.snapshots.get(this.key(selector, purpose));
    if (!registered) throw new Error('Experience source or cursor is not authorized');
    return Promise.resolve(structuredClone(registered));
  }
}

export type ExperienceEntry = {
  id: string;
  kind: 'task-trajectory' | 'seed-summary';
  taskId?: string;
  exposure: { seenInTraining: boolean; graderLabelExposed: boolean };
  taskRef?: ArtifactRef;
  overviewRef?: ArtifactRef;
  taskReportRef?: ArtifactRef;
  traceRefs?: ArtifactRef[];
};
export type ExperienceView = {
  schemaVersion: 1;
  source: SourceSelector;
  sourceManifestDigest: string;
  sourceIndexVersion: string;
  sourceEntriesDigest: string;
  provenance: 'verified' | 'unverified';
  purpose: ExperiencePurpose;
  projections: ExperienceProjection[];
  labelsExposed: false;
  authorityId: string;
  entries: ExperienceEntry[];
};
export type ExperienceViewRef = ArtifactRef;

function name(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error(`Invalid ${label}`);
}
export function validateSelector(selector: SourceSelector): void {
  if (!['deployment', 'legacy-evolution', 'campaign', 'import'].includes(selector.namespace)) throw new Error('Unknown experience source namespace');
  name(selector.sourceId, 'source ID');
  name(selector.cursor.namespace, 'cursor namespace');
  if (selector.cursor.namespace !== `${selector.namespace}:${selector.sourceId}` || !selector.cursor.value) throw new Error('Source cursor namespace mismatch');
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Each public projection is rebuilt from an allowlisted shape; grader data is never copied or referenced. */
export async function sealExperienceView(
  artifacts: FileArtifactStore, authority: ExperienceSourceAuthority, selector: SourceSelector,
  purpose: ExperiencePurpose, requested: ExperienceProjection[],
): Promise<ExperienceViewRef> {
  validateSelector(selector);
  if (!['research', 'evaluation'].includes(purpose) || requested.length === 0 || new Set(requested).size !== requested.length
    || requested.some(item => !['overview', 'task-report', 'trace-chunk'].includes(item))) throw new Error('Invalid experience projections');
  const { snapshot, grant } = await authority.resolve(selector, purpose);
  if (!same(snapshot.selector, selector)) throw new Error('Source snapshot changed or cursor mismatch');
  if (grant.purpose !== purpose || !grant.authorityId || requested.some(item => !grant.projections.includes(item))) throw new Error('Experience projection not authorized');
  if (snapshot.provenance !== (selector.namespace === 'import' ? 'unverified' : 'verified')) throw new Error('Source provenance claim invalid');
  if (purpose === 'research' && grant.exposeGraderLabels) throw new Error('Research grant cannot expose grader labels');
  if (!snapshot.indexVersion) throw new Error('Source index version required');
  assertDigest(snapshot.sourceManifestDigest);
  const ids = new Set<string>();
  const entries: ExperienceEntry[] = [];
  for (const raw of snapshot.entries) {
    name(raw.id, 'experience ID');
    const kind = raw.kind ?? 'task-trajectory';
    if (kind === 'task-trajectory') {
      if (!raw.taskId || !raw.task || typeof raw.task.prompt !== 'string') throw new Error('Physical task content required');
      name(raw.taskId, 'task ID');
      if (raw.task.executionSource) {
        if (raw.task.executionSource.kind !== 'compiled-seed-dataset'
          || !/^sha256:[0-9a-f]{64}$/u.test(raw.task.executionSource.datasetDigest)
          || !/^sha256:[0-9a-f]{64}$/u.test(raw.task.executionSource.taskContentDigest)) {
          throw new Error('Invalid physical task execution source');
        }
      }
    } else if (kind === 'seed-summary') {
      if (raw.taskId !== undefined || raw.task !== undefined || raw.grader !== undefined || raw.traceChunks.length !== 0) throw new Error('Seed summary cannot claim task or trace');
    } else throw new Error('Unknown experience kind');
    if (ids.has(raw.id)) throw new Error('Duplicate experience ID');
    ids.add(raw.id);
    if (typeof raw.exposure?.seenInTraining !== 'boolean' || typeof raw.exposure?.graderLabelExposed !== 'boolean'
      || !Array.isArray(raw.overview.tags) || !raw.overview.tags.every(tag => typeof tag === 'string')
      || typeof raw.overview.summary !== 'string' || typeof raw.taskReport.narrative !== 'string'
      || !Array.isArray(raw.traceChunks)) throw new Error('Malformed source experience');
    assertJson(raw);
    const entry: ExperienceEntry = { id: raw.id, kind, exposure: { ...raw.exposure },
      ...(kind === 'task-trajectory' ? { taskId: raw.taskId!, taskRef: artifacts.putJson({ prompt: raw.task!.prompt,
        ...(raw.task!.executionSource ? { executionSource: raw.task!.executionSource } : {}) }, 'experience.task.v1') } : {}) };
    if (requested.includes('overview')) entry.overviewRef = artifacts.putJson({ summary: raw.overview.summary, tags: raw.overview.tags }, 'experience.overview.v1');
    if (requested.includes('task-report')) entry.taskReportRef = artifacts.putJson({ narrative: raw.taskReport.narrative,
      ...(raw.taskReport.outcomeSummary === undefined ? {} : { outcomeSummary: raw.taskReport.outcomeSummary }) }, 'experience.task-report.v1');
    if (requested.includes('trace-chunk')) entry.traceRefs = raw.traceChunks.map((chunk, index) => {
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== index || typeof chunk.text !== 'string') throw new Error('Unstable trace sequence');
      return artifacts.putJson({ sequence: index, text: chunk.text }, 'experience.trace-chunk.v1');
    });
    entries.push(entry);
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const view: ExperienceView = { schemaVersion: 1, source: selector, sourceManifestDigest: snapshot.sourceManifestDigest,
    sourceIndexVersion: snapshot.indexVersion, sourceEntriesDigest: jsonDigest(snapshot.entries), provenance: snapshot.provenance,
    purpose, projections: [...requested].sort(), labelsExposed: false, authorityId: grant.authorityId, entries };
  return artifacts.putJson(view as unknown as JsonValue, 'experience.view.v1');
}

export function readExperienceView(artifacts: FileArtifactStore, ref: ExperienceViewRef): ExperienceView {
  if (ref.schemaId !== 'experience.view.v1') throw new Error('Not an experience view');
  assertDigest(ref.digest);
  const view = artifacts.getJson(ref) as unknown as ExperienceView;
  if (view.schemaVersion !== 1 || view.labelsExposed !== false || !Array.isArray(view.entries)) throw new Error('Invalid experience view');
  validateSelector(view.source);
  assertDigest(view.sourceManifestDigest);
  const seen = new Set<string>();
  for (const entry of view.entries) {
    name(entry.id, 'experience ID');
    if (entry.kind === 'task-trajectory') {
      if (!entry.taskId || !entry.taskRef) throw new Error('Physical task ref missing');
      name(entry.taskId, 'task ID');
    } else if (entry.kind === 'seed-summary') {
      if (entry.taskId !== undefined || entry.taskRef !== undefined || (entry.traceRefs?.length ?? 0) !== 0) throw new Error('Seed summary forged task or trace');
    } else throw new Error('Unknown experience kind');
    if (typeof entry.exposure?.seenInTraining !== 'boolean' || typeof entry.exposure?.graderLabelExposed !== 'boolean') throw new Error('Invalid experience exposure');
    if (seen.has(entry.id)) throw new Error('Duplicate experience ID');
    seen.add(entry.id);
    for (const child of [entry.taskRef, entry.overviewRef, entry.taskReportRef, ...(entry.traceRefs ?? [])]) if (child) artifacts.getBytes(child);
  }
  return view;
}
