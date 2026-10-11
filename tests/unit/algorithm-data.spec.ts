import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { AuthorizedExperienceSources, readExperienceView, sealExperienceView, type SourceExperience, type SourceSelector, type SourceSnapshot } from '../../src/algorithm/data/experience.js';
import { EvidenceService } from '../../src/algorithm/data/evidence.js';
import { consumeTasks, publishTasks, readTaskView, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { compareMeasurements, readMeasurement, sealMeasurement } from '../../src/algorithm/data/measurement.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-algorithm-data-')); roots.push(root);
  const artifacts = new FileArtifactStore(root);
  const selector: SourceSelector = { namespace: 'legacy-evolution', sourceId: 'evo-1', cursor: { namespace: 'legacy-evolution:evo-1', value: 'round-7' } };
  const entries: SourceExperience[] = Array.from({ length: 100 }, (_, i) => ({ id: `entry-${String(i).padStart(3, '0')}`, taskId: `task-${String(i).padStart(3, '0')}`,
    exposure: { seenInTraining: i === 0, graderLabelExposed: false }, task: { prompt: `solve ${i}` },
    overview: { summary: `observed ${i}`, tags: ['coding'] }, taskReport: { narrative: `report ${i}` },
    traceChunks: [{ sequence: 0, text: `trace ${i}` }], grader: { trueLabel: `grader-secret-${i}` } }));
  const snapshot: SourceSnapshot = { selector, sourceManifestDigest: sha256('frozen-old-journal'), indexVersion: 'idx-1', entries, provenance: 'verified' };
  const sources = new AuthorizedExperienceSources();
  sources.registerVerified(snapshot, { purpose: 'research', projections: ['overview', 'task-report', 'trace-chunk'], exposeGraderLabels: false, authorityId: 'trusted-old-journal' },
    actual => { expect(actual.sourceManifestDigest).toBe(snapshot.sourceManifestDigest); });
  const viewRef = await sealExperienceView(artifacts, sources, selector, 'research', ['overview', 'task-report', 'trace-chunk']);
  return { artifacts, selector, entries, snapshot, sources, viewRef };
}

describe('sealed experience and shared evidence access', () => {
  it('freezes 100 sourced entries, lets a recipe select 10, and keeps labels out after source append/restart', async () => {
    const f = await fixture();
    const view = readExperienceView(f.artifacts, f.viewRef);
    expect(view.entries).toHaveLength(100);
    expect(JSON.stringify(view)).not.toContain('grader-secret');
    expect(view.provenance).toBe('verified');
    f.entries.push({ ...f.entries[0]!, id: 'entry-100', taskId: 'task-100' });
    const resumed = new FileArtifactStore(f.artifacts.root);
    expect(readExperienceView(resumed, f.viewRef).entries).toHaveLength(100);
    const service = new EvidenceService(resumed, Buffer.alloc(32, 7));
    const grant = { principalId: 'campaign-1', viewDigests: [f.viewRef.digest], projections: ['overview', 'task-report', 'trace-chunk'] as const };
    const selection = Array.from({ length: 10 }, (_, i) => `task-${String(i).padStart(3, '0')}`);
    const page = service.query({ viewRef: f.viewRef, asOf: f.selector.cursor, projection: 'overview', pageSize: 10, scope: { taskIds: selection } },
      { ...grant, projections: [...grant.projections] });
    expect(page.items).toHaveLength(10);
    expect(page.nextPageToken).toBeUndefined();
    expect(resumed.getJson(page.receiptRef)).toMatchObject({ kind: 'evidence.query.receipt.v1', usage: { returnedItems: 10 } });
    const content = service.read({ viewRef: f.viewRef, asOf: f.selector.cursor, contentDigest: page.items[0]!.contentRef.digest },
      { ...grant, projections: [...grant.projections] });
    expect(content.text).toContain('observed 0');
    expect(content.text).not.toContain('grader-secret');
  });

  it('binds tokens to the whole query and checks scope before digest reads', async () => {
    const f = await fixture();
    const service = new EvidenceService(f.artifacts, Buffer.alloc(32, 3));
    const grant = { principalId: 'role-1', viewDigests: [f.viewRef.digest], projections: ['overview', 'task-report', 'trace-chunk'] as Array<'overview' | 'task-report' | 'trace-chunk'>,
      taskIds: ['task-000', 'task-001'] };
    const request = { viewRef: f.viewRef, asOf: f.selector.cursor, projection: 'overview' as const, pageSize: 1, scope: { taskIds: ['task-000', 'task-001'] } };
    const first = service.query(request, grant);
    expect(first.nextPageToken).toBeDefined();
    expect(service.query({ ...request, pageToken: first.nextPageToken! }, grant).items[0]!.taskId).toBe('task-001');
    expect(() => service.query({ ...request, projection: 'task-report', pageToken: first.nextPageToken! }, grant)).toThrow(/token/);
    expect(() => service.query({ ...request, pageToken: `${first.nextPageToken}x` }, grant)).toThrow(/token/);
    expect(() => service.query({ ...request, scope: { taskIds: ['task-009'] } }, grant)).toThrow(/access denied/);
    expect(() => service.query({ ...request, asOf: { ...f.selector.cursor, value: 'later' } }, grant)).toThrow(/cursor mismatch/);
    expect(() => service.read({ viewRef: f.viewRef, asOf: f.selector.cursor, contentDigest: readExperienceView(f.artifacts, f.viewRef).entries[9]!.overviewRef!.digest }, grant)).toThrow(/access denied/);
    expect(() => service.read({ viewRef: f.viewRef, asOf: f.selector.cursor, contentDigest: sha256('unlisted') }, grant)).toThrow(/not in sealed view/);
    expect(() => service.query(request, { ...grant, viewDigests: [] })).toThrow(/access denied/);
  });

  it('rejects unsupported source/provenance claims and unapproved snapshots', async () => {
    const f = await fixture();
    await expect(sealExperienceView(f.artifacts, f.sources, { ...f.selector, cursor: { ...f.selector.cursor, value: 'later' } }, 'research', ['overview'])).rejects.toThrow(/authorized/);
    const imports = new AuthorizedExperienceSources();
    expect(() => imports.registerImport({ ...f.snapshot, selector: { namespace: 'import', sourceId: 'file-1', cursor: { namespace: 'import:file-1', value: 'v1' } } },
      { purpose: 'research', projections: ['overview'], exposeGraderLabels: false, authorityId: 'operator' })).toThrow(/unverified provenance/);
  });
});

describe('task exposure and measurement conditions', () => {
  it('inherits exposure, rejects seen train as unseen test, and advances a sealed cursor', async () => {
    const f = await fixture();
    expect(() => taskViewFromExperience(f.artifacts, f.viewRef, [{ id: 'task-000', purpose: 'final-test' }])).toThrow(/Exposed task/);
    const initial = taskViewFromExperience(f.artifacts, f.viewRef, [{ id: 'task-000', purpose: 'train' }, { id: 'task-001', purpose: 'development' }]);
    const newContent = f.artifacts.putJson({ prompt: 'derived' });
    expect(() => publishTasks(f.artifacts, initial, [{ id: 'new-test', contentRef: newContent, purpose: 'final-test', parentTaskIds: ['task-000'] }])).toThrow(/cannot become final-test/);
    expect(() => publishTasks(f.artifacts, initial, [{ id: 'fresh-test', contentRef: newContent, purpose: 'final-test', parentTaskIds: ['task-001'] }])).toThrow(/cannot become final-test/);
    const next = publishTasks(f.artifacts, initial, [{ id: 'new-train', contentRef: newContent, purpose: 'train', parentTaskIds: ['task-000'] }]);
    expect(readTaskView(f.artifacts, next).tasks[2]!.exposure.seenInTraining).toBe(true);
    const consumed = consumeTasks(f.artifacts, next, { viewDigest: next.digest, nextIndex: 0 }, 2);
    expect(consumed.tasks.map(item => item.id)).toEqual(['task-000', 'task-001']);
    expect(consumed.cursor.nextIndex).toBe(2);
    expect(() => consumeTasks(f.artifacts, next, { ...consumed.cursor, viewDigest: initial.digest }, 1)).toThrow(/cursor mismatch/);
  });

  it('merges duplicate source exposure and rejects conflicting task content', async () => {
    const f = await fixture();
    const duplicate = { ...f.entries[0]!, id: 'entry-101', exposure: { seenInTraining: false, graderLabelExposed: false } };
    const register = (extra: SourceExperience) => {
      const selector = { ...f.selector, sourceId: `dupe-${extra.id}`, cursor: { namespace: `legacy-evolution:dupe-${extra.id}`, value: 'v1' } };
      const sources = new AuthorizedExperienceSources();
      sources.registerVerified({ ...f.snapshot, selector, entries: [f.entries[0]!, extra] },
        { purpose: 'research', projections: ['overview'], exposeGraderLabels: false, authorityId: 'trusted' }, () => {});
      return { selector, sources };
    };
    const a = register(duplicate);
    const view = await sealExperienceView(f.artifacts, a.sources, a.selector, 'research', ['overview']);
    expect(() => taskViewFromExperience(f.artifacts, view, [{ id: 'task-000', purpose: 'final-test' }])).toThrow(/Exposed task/);
    const b = register({ ...duplicate, id: 'entry-102', task: { prompt: 'different task' } });
    const inconsistent = await sealExperienceView(f.artifacts, b.sources, b.selector, 'research', ['overview']);
    expect(() => taskViewFromExperience(f.artifacts, inconsistent, [{ id: 'task-000', purpose: 'train' }])).toThrow(/Conflicting task content/);
  });

  it('compares matching conditions, rejects a new judge, and retains old re-evaluation evidence', async () => {
    const f = await fixture();
    const taskViewRef = taskViewFromExperience(f.artifacts, f.viewRef, [{ id: 'task-001', purpose: 'development' }]);
    const modelA = f.artifacts.putJson({ model: 'A' }, 'model.v1'), modelB = f.artifacts.putJson({ model: 'B' }, 'model.v1');
    const bindings = new BindingStore(f.artifacts, { id: 'agent.v1', slots: { 'target.model': { schemaId: 'model.v1', required: true, replaceable: true } } });
    const subjectA = bindings.create({ 'target.model': modelA }), subjectB = bindings.create({ 'target.model': modelB });
    const artifact = (name: string) => f.artifacts.putJson({ name });
    const condition = { taskViewRef, providerImplementationDigest: sha256('provider'), evaluatorRef: artifact('judge-1'), rubricRef: artifact('rubric'),
      environmentRef: artifact('env'), samplingRef: artifact('sample'), budgetRef: artifact('budget'),
      metricSchemaRef: f.artifacts.putJson({ schemaVersion: 1, metrics: { reward: { unit: 'points', minimum: 0 } } }, 'measurement.metric-schema.v1'), subjectSchemaId: 'agent.v1' };
    const evidenceRefs = [artifact('evidence')];
    const a = sealMeasurement(f.artifacts, { subjectBindings: subjectA, condition, evidenceRefs, metrics: { reward: 1 }, evaluatedAtCursor: 'eval-1' });
    const b = sealMeasurement(f.artifacts, { subjectBindings: subjectB, condition, evidenceRefs, metrics: { reward: 3 }, evaluatedAtCursor: 'eval-2' });
    expect(compareMeasurements(f.artifacts, a, b)).toEqual({ reward: 2 });
    const judgedAgain = sealMeasurement(f.artifacts, { subjectBindings: subjectA, condition: { ...condition, evaluatorRef: artifact('judge-2') },
      evidenceRefs: [artifact('new-evidence')], metrics: { reward: 4 }, evaluatedAtCursor: 'eval-3', reevaluates: a.digest });
    expect(() => compareMeasurements(f.artifacts, a, judgedAgain)).toThrow(/not directly comparable/);
    expect(readMeasurement(f.artifacts, a).metrics.reward).toBe(1);
    expect(readMeasurement(f.artifacts, judgedAgain).reevaluates).toBe(a.digest);
    expect(() => sealMeasurement(f.artifacts, { subjectBindings: subjectA, condition, evidenceRefs, metrics: { wrong: 1 }, evaluatedAtCursor: 'eval-bad' })).toThrow(/metric names/);
    expect(() => sealMeasurement(f.artifacts, { subjectBindings: subjectA, condition, evidenceRefs, metrics: { reward: 'high' as unknown as number }, evaluatedAtCursor: 'eval-bad' })).toThrow(/Invalid measurement metric/);
  });
});
