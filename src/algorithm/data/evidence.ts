import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ArtifactRef } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { readExperienceView, type ExperienceProjection, type ExperienceViewRef, type SourceCursor } from './experience.js';

export type EvidenceGrant = {
  principalId: string;
  viewDigests: string[];
  projections: ExperienceProjection[];
  taskIds?: string[];
};
export type EvidenceQuery = {
  viewRef: ExperienceViewRef;
  asOf: SourceCursor;
  scope?: { entryIds?: string[]; taskIds?: string[] };
  projection: ExperienceProjection;
  pageSize: number;
  pageToken?: string;
};
export type EvidenceItem = { entryId: string; taskId?: string; sequence?: number; contentRef: ArtifactRef };
export type EvidenceUsage = { returnedItems: number; returnedBytes: number; requests: number };
export type EvidencePage = { items: EvidenceItem[]; receiptRef: ArtifactRef; usage: EvidenceUsage; nextPageToken?: string };
export type EvidenceRead = { viewRef: ExperienceViewRef; asOf: SourceCursor; contentDigest: string; range?: { start: number; length: number } };
export type EvidenceContent = { text: string; mediaType: string; receiptRef: ArtifactRef; usage: EvidenceUsage; totalBytes: number };

function equal(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function sorted(values: string[] | undefined): string[] | undefined { return values === undefined ? undefined : [...new Set(values)].sort(); }
function authorize(viewRef: ExperienceViewRef, projection: ExperienceProjection, grant: EvidenceGrant): void {
  if (!grant.principalId || !grant.viewDigests.includes(viewRef.digest) || !grant.projections.includes(projection)) throw new Error('Evidence access denied');
}

/** The same service is called by recipe providers and role tools. It enforces API access, not OS isolation. */
export class EvidenceService {
  readonly tokenKeyDigest: string;
  private readonly tokenKey: Uint8Array;
  constructor(readonly artifacts: FileArtifactStore, tokenKey: Uint8Array,
    readonly maxPageSize = 100, readonly maxReadBytes = 64 * 1024) {
    if (tokenKey.length < 32) throw new Error('Evidence page token key must be at least 32 bytes');
    this.tokenKey = Buffer.from(tokenKey);
    this.tokenKeyDigest = createHash('sha256').update(this.tokenKey).digest('hex');
  }
  private token(queryDigest: string, offset: number): string {
    const body = Buffer.from(canonicalJson({ queryDigest, offset })).toString('base64url');
    const mac = createHmac('sha256', this.tokenKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  private offset(token: string | undefined, queryDigest: string): number {
    if (token === undefined) return 0;
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new Error('Invalid evidence page token');
    const [body, signature] = token.split('.');
    const expected = createHmac('sha256', this.tokenKey).update(body!).digest();
    const actual = Buffer.from(signature!, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid evidence page token');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')); } catch { throw new Error('Invalid evidence page token'); }
    const value = parsed as { queryDigest?: unknown; offset?: unknown };
    if (value.queryDigest !== queryDigest || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new Error('Evidence page token query mismatch');
    return value.offset as number;
  }
  private view(ref: ExperienceViewRef, asOf: SourceCursor) {
    const view = readExperienceView(this.artifacts, ref);
    if (!equal(view.source.cursor, asOf)) throw new Error('Evidence source cursor mismatch');
    return view;
  }
  private checkTasks(taskIds: string[] | undefined, grant: EvidenceGrant): void {
    if (taskIds && grant.taskIds && taskIds.some(id => !grant.taskIds!.includes(id))) throw new Error('Evidence task access denied');
  }
  private queryDigest(request: EvidenceQuery, grant: EvidenceGrant): string {
    return jsonDigest({ viewDigest: request.viewRef.digest, asOf: request.asOf,
      scope: { taskIds: sorted(request.scope?.taskIds) ?? null, entryIds: sorted(request.scope?.entryIds) ?? null },
      projection: request.projection, pageSize: request.pageSize, principalId: grant.principalId,
      grantScopeDigest: jsonDigest({ viewDigests: sorted(grant.viewDigests), projections: sorted(grant.projections), taskIds: sorted(grant.taskIds) ?? null }) });
  }
  checkQuery(request: EvidenceQuery, grant: EvidenceGrant): void {
    authorize(request.viewRef, request.projection, grant);
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > this.maxPageSize) throw new Error('Invalid evidence page size');
    const view = this.view(request.viewRef, request.asOf);
    if (!view.projections.includes(request.projection)) throw new Error('Projection absent from sealed view');
    this.checkTasks(request.scope?.taskIds, grant);
    this.offset(request.pageToken, this.queryDigest(request, grant));
  }
  checkRead(request: EvidenceRead, grant: EvidenceGrant): void {
    assertDigest(request.contentDigest);
    const view = this.view(request.viewRef, request.asOf);
    for (const entry of view.entries) {
      const choices: Array<[ArtifactRef | undefined, ExperienceProjection]> = [[entry.overviewRef, 'overview'], [entry.taskReportRef, 'task-report'],
        ...(entry.traceRefs ?? []).map(ref => [ref, 'trace-chunk'] as [ArtifactRef, ExperienceProjection])];
      for (const [ref, projection] of choices) if (ref?.digest === request.contentDigest) {
        authorize(request.viewRef, projection, grant);
        if (!entry.taskId && grant.taskIds) throw new Error('Evidence task access denied');
        if (entry.taskId) this.checkTasks([entry.taskId], grant);
        if (request.range) {
          const total = this.artifacts.getBytes(ref).length;
          if (!Number.isSafeInteger(request.range.start) || request.range.start < 0 || request.range.start > total
            || !Number.isSafeInteger(request.range.length) || request.range.length < 0 || request.range.length > this.maxReadBytes
            || request.range.start + request.range.length > total) throw new Error('Invalid evidence read range');
        }
        return;
      }
    }
    throw new Error('Evidence digest is not in sealed view');
  }
  query(request: EvidenceQuery, grant: EvidenceGrant): EvidencePage {
    this.checkQuery(request, grant);
    const view = this.view(request.viewRef, request.asOf);
    const taskIds = sorted(request.scope?.taskIds), entryIds = sorted(request.scope?.entryIds);
    this.checkTasks(taskIds, grant);
    const queryDigest = this.queryDigest(request, grant);
    const candidates: EvidenceItem[] = [];
    for (const entry of view.entries) {
      if (taskIds && (!entry.taskId || !taskIds.includes(entry.taskId)) || entryIds && !entryIds.includes(entry.id)) continue;
      if (grant.taskIds && (!entry.taskId || !grant.taskIds.includes(entry.taskId))) continue;
      const common = { entryId: entry.id, ...(entry.taskId ? { taskId: entry.taskId } : {}) };
      if (request.projection === 'overview' && entry.overviewRef) candidates.push({ ...common, contentRef: entry.overviewRef });
      if (request.projection === 'task-report' && entry.taskReportRef) candidates.push({ ...common, contentRef: entry.taskReportRef });
      if (request.projection === 'trace-chunk') for (const [sequence, contentRef] of (entry.traceRefs ?? []).entries()) candidates.push({ ...common, sequence, contentRef });
    }
    const offset = this.offset(request.pageToken, queryDigest);
    if (offset > candidates.length) throw new Error('Evidence page token outside result');
    const items = candidates.slice(offset, offset + request.pageSize);
    const usage = { returnedItems: items.length, returnedBytes: Buffer.byteLength(canonicalJson(items)), requests: 1 };
    const receiptRef = this.artifacts.putJson({ kind: 'evidence.query.receipt.v1', queryDigest, viewDigest: request.viewRef.digest,
      asOf: request.asOf, returned: items.map(item => item.contentRef.digest), usage } as JsonValue, 'evidence.receipt.v1');
    return { items, receiptRef, usage, ...(offset + items.length < candidates.length ? { nextPageToken: this.token(queryDigest, offset + items.length) } : {}) };
  }
  read(request: EvidenceRead, grant: EvidenceGrant): EvidenceContent {
    this.checkRead(request, grant);
    const view = this.view(request.viewRef, request.asOf);
    const refs: Array<{ ref: ArtifactRef; projection: ExperienceProjection; taskId?: string }> = [];
    for (const entry of view.entries) {
      const task = entry.taskId ? { taskId: entry.taskId } : {};
      if (entry.overviewRef) refs.push({ ref: entry.overviewRef, projection: 'overview', ...task });
      if (entry.taskReportRef) refs.push({ ref: entry.taskReportRef, projection: 'task-report', ...task });
      for (const ref of entry.traceRefs ?? []) refs.push({ ref, projection: 'trace-chunk', ...task });
    }
    const hit = refs.find(item => item.ref.digest === request.contentDigest);
    if (!hit) throw new Error('Evidence digest is not in sealed view');
    authorize(request.viewRef, hit.projection, grant);
    if (!hit.taskId && grant.taskIds) throw new Error('Evidence task access denied');
    if (hit.taskId) this.checkTasks([hit.taskId], grant);
    const bytes = this.artifacts.getBytes(hit.ref);
    const start = request.range?.start ?? 0;
    const length = request.range?.length ?? Math.min(this.maxReadBytes, bytes.length - start);
    if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length || !Number.isSafeInteger(length) || length < 0 || length > this.maxReadBytes || start + length > bytes.length) throw new Error('Invalid evidence read range');
    const usage = { returnedItems: 1, returnedBytes: length, requests: 1 };
    const receiptRef = this.artifacts.putJson({ kind: 'evidence.read.receipt.v1', viewDigest: request.viewRef.digest,
      contentDigest: hit.ref.digest, asOf: request.asOf, start, length, principalId: grant.principalId, usage } as JsonValue, 'evidence.receipt.v1');
    return { text: bytes.subarray(start, start + length).toString('utf8'), mediaType: hit.ref.mediaType, receiptRef, usage, totalBytes: bytes.length };
  }
}
