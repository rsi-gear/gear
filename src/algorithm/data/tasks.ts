import type { ArtifactRef } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { canonicalJson, type JsonValue } from '../schema.js';
import { readExperienceView, type ExperienceViewRef } from './experience.js';

export type TaskPurpose = 'train' | 'development' | 'final-test';
export type TaskExposure = { seenInTraining: boolean; graderLabelExposed: boolean };
export type TaskEntry = { id: string; contentRef: ArtifactRef; purpose: TaskPurpose; exposure: TaskExposure; ancestry: string[] };
export type TaskView = { schemaVersion: 1; sourceExperienceViewDigest?: string; parentTaskViewDigest?: string; tasks: TaskEntry[];
  authorityProof?: { issuerId: string; mac: string } };
export type TaskViewRef = ArtifactRef;
export type TaskCursor = { viewDigest: string; nextIndex: number };
export type PublishedTask = { id: string; contentRef: ArtifactRef; purpose: TaskPurpose; parentTaskIds: string[] };

/** Trusted host capability. Recipe JSON cannot forge a managed TaskView or grant itself lineage access. */
export class TaskViewAuthority {
  readonly keyDigest: string;
  private readonly key: Uint8Array;
  constructor(readonly artifacts: FileArtifactStore, readonly issuerId: string, key: Uint8Array) {
    if (!issuerId || key.length < 32) throw new Error('TaskView authority identity/key required');
    this.key = Buffer.from(key);
    this.keyDigest = createHash('sha256').update(this.key).digest('hex');
  }
  private mac(view: Omit<TaskView, 'authorityProof'>): string {
    return createHmac('sha256', this.key).update(canonicalJson(view)).digest('hex');
  }
  seal(view: Omit<TaskView, 'authorityProof'>): TaskViewRef {
    if (!view.sourceExperienceViewDigest) throw new Error('Managed TaskView needs an experience root');
    const signed: TaskView = { ...view, authorityProof: { issuerId: this.issuerId, mac: this.mac(view) } };
    const ref = this.artifacts.putJson(signed as unknown as JsonValue, 'task.view.v1');
    this.verify(ref, [view.sourceExperienceViewDigest]);
    return ref;
  }
  verify(ref: TaskViewRef, allowedExperienceViewDigests: readonly string[]): TaskView {
    const view = readTaskView(this.artifacts, ref);
    if (!view.sourceExperienceViewDigest || !allowedExperienceViewDigests.includes(view.sourceExperienceViewDigest)
      || view.authorityProof?.issuerId !== this.issuerId || !/^[a-f0-9]{64}$/u.test(view.authorityProof.mac)) throw new Error('Managed TaskView not authorized');
    const { authorityProof, ...body } = view;
    const expected = Buffer.from(this.mac(body), 'hex');
    const actual = Buffer.from(authorityProof.mac, 'hex');
    if (!timingSafeEqual(expected, actual)) throw new Error('Managed TaskView signature mismatch');
    return view;
  }
}

function identifier(id: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error('Invalid task ID'); }
function purpose(value: TaskPurpose): void { if (!['train', 'development', 'final-test'].includes(value)) throw new Error('Invalid task purpose'); }
function validateEntry(artifacts: FileArtifactStore, task: TaskEntry): void {
  identifier(task.id); purpose(task.purpose); artifacts.getBytes(task.contentRef);
  if (typeof task.exposure?.seenInTraining !== 'boolean' || typeof task.exposure?.graderLabelExposed !== 'boolean' || !Array.isArray(task.ancestry)) throw new Error('Invalid task exposure');
  if (task.purpose === 'final-test' && (task.exposure.seenInTraining || task.exposure.graderLabelExposed)) throw new Error('Exposed task cannot become unseen final test');
  for (const ancestor of task.ancestry) identifier(ancestor);
}
export function readTaskView(artifacts: FileArtifactStore, ref: TaskViewRef): TaskView {
  if (ref.schemaId !== 'task.view.v1') throw new Error('Not a task view');
  const view = artifacts.getJson(ref) as unknown as TaskView;
  if (view.schemaVersion !== 1 || !Array.isArray(view.tasks)) throw new Error('Invalid task view');
  if (view.sourceExperienceViewDigest) assertDigest(view.sourceExperienceViewDigest);
  if (view.parentTaskViewDigest) assertDigest(view.parentTaskViewDigest);
  const ids = new Set<string>();
  for (const task of view.tasks) { validateEntry(artifacts, task); if (ids.has(task.id)) throw new Error('Duplicate task ID'); ids.add(task.id); }
  return view;
}

/** Admission-side construction from an already sealed, authorized research/evaluation view. */
export function prepareTaskViewFromExperience(artifacts: FileArtifactStore, experienceRef: ExperienceViewRef,
  tasks: Array<{ id: string; purpose: TaskPurpose; seenInTraining?: boolean }>): TaskView {
  const experience = readExperienceView(artifacts, experienceRef);
  const allowed = new Map<string, { taskRef: ArtifactRef; exposure: TaskExposure }>();
  for (const item of experience.entries) {
    if (item.kind !== 'task-trajectory' || !item.taskId || !item.taskRef) continue;
    const previous = allowed.get(item.taskId);
    if (previous && artifacts.getBytes(previous.taskRef).compare(artifacts.getBytes(item.taskRef)) !== 0) throw new Error('Conflicting task content in experience view');
    allowed.set(item.taskId, { taskRef: previous?.taskRef ?? item.taskRef,
      exposure: { seenInTraining: (previous?.exposure.seenInTraining ?? false) || item.exposure.seenInTraining,
        graderLabelExposed: (previous?.exposure.graderLabelExposed ?? false) || item.exposure.graderLabelExposed } });
  }
  const entries: TaskEntry[] = tasks.map(task => {
    const source = allowed.get(task.id);
    if (!source) throw new Error('Task absent from sealed experience view');
    const exposure = { seenInTraining: task.seenInTraining ?? source.exposure.seenInTraining,
      graderLabelExposed: source.exposure.graderLabelExposed };
    if (source.exposure.seenInTraining && !exposure.seenInTraining) throw new Error('Cannot erase training exposure');
    const entry = { id: task.id, contentRef: source.taskRef, purpose: task.purpose, exposure, ancestry: [] };
    validateEntry(artifacts, entry);
    return entry;
  });
  const view: TaskView = { schemaVersion: 1, sourceExperienceViewDigest: experienceRef.digest, tasks: entries };
  if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('Duplicate task ID');
  return view;
}
export function taskViewFromExperience(artifacts: FileArtifactStore, experienceRef: ExperienceViewRef,
  tasks: Array<{ id: string; purpose: TaskPurpose; seenInTraining?: boolean }>): TaskViewRef {
  const view = prepareTaskViewFromExperience(artifacts, experienceRef, tasks);
  const ref = artifacts.putJson(view as unknown as JsonValue, 'task.view.v1');
  readTaskView(artifacts, ref);
  return ref;
}

/** New tasks inherit exposure and provenance from their declared parent tasks. */
export function preparePublishedTaskView(artifacts: FileArtifactStore, parentRef: TaskViewRef, additions: PublishedTask[]): TaskView {
  const parent = readTaskView(artifacts, parentRef);
  if (additions.length === 0) throw new Error('Task publication is empty');
  const lookup = new Map(parent.tasks.map(task => [task.id, task]));
  const used = new Set(parent.tasks.map(task => task.id));
  const published: TaskEntry[] = [];
  for (const task of additions) {
    identifier(task.id); purpose(task.purpose);
    if (task.purpose === 'final-test') throw new Error('Published tasks cannot become final-test; use trusted independent admission');
    if (used.has(task.id)) throw new Error('Duplicate task ID');
    used.add(task.id);
    if (!Array.isArray(task.parentTaskIds) || task.parentTaskIds.length === 0 || new Set(task.parentTaskIds).size !== task.parentTaskIds.length) throw new Error('Published task needs distinct parents');
    const parents = task.parentTaskIds.map(id => { const found = lookup.get(id); if (!found) throw new Error('Unknown parent task'); return found; });
    if (parents.some(item => item.purpose === 'final-test')) throw new Error('Final-test ancestry cannot be repurposed');
    const entry: TaskEntry = { id: task.id, contentRef: task.contentRef, purpose: task.purpose,
      exposure: { seenInTraining: task.purpose === 'train' || parents.some(item => item.exposure.seenInTraining),
        graderLabelExposed: parents.some(item => item.exposure.graderLabelExposed) },
      ancestry: [...new Set(parents.flatMap(item => [item.id, ...item.ancestry]))].sort() };
    validateEntry(artifacts, entry);
    published.push(entry);
  }
  const next: TaskView = { schemaVersion: 1, parentTaskViewDigest: parentRef.digest,
    ...(parent.sourceExperienceViewDigest ? { sourceExperienceViewDigest: parent.sourceExperienceViewDigest } : {}), tasks: [...parent.tasks, ...published] };
  return next;
}
export function publishTasks(artifacts: FileArtifactStore, parentRef: TaskViewRef, additions: PublishedTask[]): TaskViewRef {
  const next = preparePublishedTaskView(artifacts, parentRef, additions);
  const ref = artifacts.putJson(next as unknown as JsonValue, 'task.view.v1');
  readTaskView(artifacts, ref);
  return ref;
}

/** The returned cursor belongs in algorithm state and advances with any related binding transition. */
export function consumeTasks(artifacts: FileArtifactStore, ref: TaskViewRef, cursor: TaskCursor, count: number): { tasks: TaskEntry[]; cursor: TaskCursor } {
  const view = readTaskView(artifacts, ref);
  if (cursor.viewDigest !== ref.digest || !Number.isSafeInteger(cursor.nextIndex) || cursor.nextIndex < 0 || cursor.nextIndex > view.tasks.length
    || !Number.isSafeInteger(count) || count < 0) throw new Error('Task cursor mismatch');
  const tasks = view.tasks.slice(cursor.nextIndex, cursor.nextIndex + count);
  return { tasks, cursor: { viewDigest: ref.digest, nextIndex: cursor.nextIndex + tasks.length } };
}
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
