/** Admit a verified old seed dataset as a new, authorized research TaskView. */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EvolutionRegistryStore } from '../state/evolution.js';
import type { ArtifactRef } from '../algorithm/contracts.js';
import { FileArtifactStore } from '../algorithm/artifacts.js';
import { canonicalJson, assertJson } from '../algorithm/schema.js';
import { HistoricalSeedExperienceSource } from '../algorithm/data/history-source.js';
import { sealExperienceView, type SourceSelector, type SourceSnapshot } from '../algorithm/data/experience.js';
import { prepareTaskViewFromExperience, TaskViewAuthority, type TaskViewRef } from '../algorithm/data/tasks.js';

export type HistoricalSeedTaskSource = {
  /** Trusted, existing registry; this API never calls initialize(). */
  registry: EvolutionRegistryStore;
  evolutionId: string;
  roundId: string;
  /** Explicit root containing the compiled seed dataset named by the old spec. */
  workspaceRoot: string;
  authorityId: string;
  maxTasks?: number;
};

/** This is a pinned source identity, not an author-supplied assertion of verification. */
export type HistoricalSeedTaskPinV1 = {
  schemaVersion: 1;
  kind: 'historical-seed-task-pin';
  source: { registryRoot: string; workspaceRoot: string; datasetRoot: string; evolutionId: string; roundId: string;
    authorityId: string; maxTasks: number };
  selector: SourceSelector;
  sourceManifestDigest: string;
  sourceIndexVersion: string;
  taskIds: string[];
};

export type HistoricalSeedTaskImport = {
  selector: SourceSelector;
  sourceManifestDigest: string;
  experienceViewRef: ArtifactRef;
  taskViewRef: TaskViewRef;
  provenance: 'verified';
  purpose: 'research';
};

export type HistoricalSeedTaskImportCode = 'source-invalid' | 'source-verification-failed'
  | 'source-identity-drift' | 'destination-overlap' | 'destination-authority-mismatch'
  | 'task-not-authorized';
export class HistoricalSeedTaskImportError extends Error {
  constructor(readonly code: HistoricalSeedTaskImportCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HistoricalSeedTaskImportError';
  }
}

function sourceOptions(source: HistoricalSeedTaskSource): void {
  if (!source || typeof source !== 'object' || !source.registry
    || typeof source.registry.root !== 'string' || !isAbsolute(source.registry.root)
    || typeof source.workspaceRoot !== 'string' || !isAbsolute(source.workspaceRoot)
    || !source.evolutionId || !source.roundId || !source.authorityId
    || source.registry.root.includes('\0') || source.workspaceRoot.includes('\0')
    || 'evaluationId' in source || 'trajectoryReader' in source || 'maxTraceNodes' in source
    || source.maxTasks !== undefined && (!Number.isSafeInteger(source.maxTasks) || source.maxTasks < 1))
    throw new HistoricalSeedTaskImportError('source-invalid', 'exact trusted task-only source and absolute roots required');
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
function overlaps(left: string, right: string): boolean { return inside(left, right) || inside(right, left); }
async function roots(source: HistoricalSeedTaskSource): Promise<{ registryRoot: string; workspaceRoot: string; datasetRoot: string }> {
  try {
    const spec = await source.registry.requireSpec(source.evolutionId);
    const [registryRoot, workspaceRoot, datasetRoot] = await Promise.all([
      realpath(resolve(source.registry.root)), realpath(resolve(source.workspaceRoot)),
      realpath(resolve(source.workspaceRoot, spec.datasets.seed.ref)),
    ]);
    return { registryRoot, workspaceRoot, datasetRoot };
  } catch (error) {
    throw new HistoricalSeedTaskImportError('source-verification-failed', `source root unavailable: ${String(error)}`);
  }
}
function checkedTaskIds(snapshot: SourceSnapshot): string[] {
  if (snapshot.provenance !== 'verified' || snapshot.entries.length === 0)
    throw new HistoricalSeedTaskImportError('source-verification-failed', 'physical seed task source is unavailable');
  const taskIds = snapshot.entries.map(entry => {
    if (entry.kind !== 'task-trajectory' || !entry.taskId || !entry.task?.executionSource
      || entry.task.executionSource.kind !== 'compiled-seed-dataset'
      || entry.exposure.seenInTraining !== true || entry.exposure.graderLabelExposed !== false)
      throw new HistoricalSeedTaskImportError('source-verification-failed', 'seed source has no safe physical task projection');
    return entry.taskId;
  });
  if (new Set(taskIds).size !== taskIds.length)
    throw new HistoricalSeedTaskImportError('source-verification-failed', 'seed task IDs are not unique');
  return taskIds.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** Pure source inspection. Missing registry/spec/round/dataset never becomes a verified pin. */
export async function inspectHistoricalSeedTaskSource(source: HistoricalSeedTaskSource): Promise<HistoricalSeedTaskPinV1> {
  sourceOptions(source);
  const before = await roots(source);
  const authority = new HistoricalSeedExperienceSource({ registry: source.registry,
    evolutionId: source.evolutionId, roundId: source.roundId, workspaceRoot: source.workspaceRoot,
    authorityId: source.authorityId, ...(source.maxTasks === undefined ? {} : { maxTasks: source.maxTasks }) });
  let selector: SourceSelector, snapshot: SourceSnapshot;
  try {
    selector = await authority.selector();
    const resolved = await authority.resolve(selector, 'research');
    snapshot = resolved.snapshot;
    if (resolved.grant.purpose !== 'research' || resolved.grant.authorityId !== source.authorityId
      || resolved.grant.exposeGraderLabels || !resolved.grant.projections.includes('overview')
      || !resolved.grant.projections.includes('task-report'))
      throw new HistoricalSeedTaskImportError('source-verification-failed', 'source research projection grant invalid');
  } catch (error) {
    if (error instanceof HistoricalSeedTaskImportError) throw error;
    throw new HistoricalSeedTaskImportError('source-verification-failed', `old source verification failed: ${String(error)}`);
  }
  if (selector.namespace !== 'legacy-evolution' || selector.sourceId !== source.evolutionId
    || selector.cursor.namespace !== `legacy-evolution:${source.evolutionId}`
    || selector.cursor.value !== snapshot.sourceManifestDigest
    || canonicalJson(selector) !== canonicalJson(snapshot.selector))
    throw new HistoricalSeedTaskImportError('source-verification-failed', 'old source selector is not a verified seed snapshot');
  const taskIds = checkedTaskIds(snapshot);
  const after = await roots(source);
  if (canonicalJson(before) !== canonicalJson(after))
    throw new HistoricalSeedTaskImportError('source-identity-drift', 'source roots moved during inspection');
  return { schemaVersion: 1, kind: 'historical-seed-task-pin', source: {
    ...before, evolutionId: source.evolutionId, roundId: source.roundId,
    authorityId: source.authorityId, maxTasks: source.maxTasks ?? 1_000 },
  selector, sourceManifestDigest: snapshot.sourceManifestDigest,
  sourceIndexVersion: snapshot.indexVersion, taskIds };
}

/** Reverify a host-held pin, then seal only authorized research tasks into a separate new CAS. */
export async function importHistoricalSeedTaskView(options: { source: HistoricalSeedTaskSource;
  pin: HistoricalSeedTaskPinV1; artifacts: FileArtifactStore; taskAuthority: TaskViewAuthority;
  tasks: Array<{ id: string; purpose: 'train' | 'development' }> }): Promise<HistoricalSeedTaskImport> {
  sourceOptions(options.source);
  if (!(options.artifacts instanceof FileArtifactStore) || !(options.taskAuthority instanceof TaskViewAuthority)
    || options.taskAuthority.artifacts !== options.artifacts)
    throw new HistoricalSeedTaskImportError('destination-authority-mismatch', 'TaskView authority must use the destination CAS');
  if (typeof options.artifacts.root !== 'string' || !isAbsolute(options.artifacts.root))
    throw new HistoricalSeedTaskImportError('destination-overlap', 'destination CAS root must be explicit and absolute');
  const sourceRoots = await roots(options.source);
  let destinationRoot: string;
  try { destinationRoot = await realpath(resolve(options.artifacts.root)); }
  catch (error) { throw new HistoricalSeedTaskImportError('destination-overlap', `destination CAS root unavailable: ${String(error)}`); }
  if (overlaps(destinationRoot, sourceRoots.registryRoot) || overlaps(destinationRoot, sourceRoots.workspaceRoot)
    || overlaps(destinationRoot, sourceRoots.datasetRoot))
    throw new HistoricalSeedTaskImportError('destination-overlap', 'destination CAS overlaps a historical source root');
  // FileArtifactStore creates objects/ in its constructor but does not reject a pre-existing symlink.
  // Validate the actual object sink before sealExperienceView can write any artifact.
  const objectPath = join(options.artifacts.root, 'objects');
  try {
    const entry = await lstat(objectPath);
    const objectRoot = await realpath(objectPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || objectRoot !== join(destinationRoot, 'objects'))
      throw new Error('objects directory is not direct and regular');
  } catch (error) {
    throw new HistoricalSeedTaskImportError('destination-overlap', `destination CAS object sink invalid: ${String(error)}`);
  }
  let pin: HistoricalSeedTaskPinV1;
  try {
    assertJson(options.pin);
    pin = options.pin;
    if (pin.schemaVersion !== 1 || pin.kind !== 'historical-seed-task-pin') throw new Error('pin version/kind invalid');
  } catch (error) { throw new HistoricalSeedTaskImportError('source-invalid', `typed historical source pin required: ${String(error)}`); }
  let current: HistoricalSeedTaskPinV1;
  try { current = await inspectHistoricalSeedTaskSource(options.source); }
  catch (error) {
    if (error instanceof HistoricalSeedTaskImportError && error.code === 'source-invalid') throw error;
    throw new HistoricalSeedTaskImportError('source-identity-drift', `pinned source cannot be reverified: ${String(error)}`);
  }
  if (canonicalJson(pin) !== canonicalJson(current))
    throw new HistoricalSeedTaskImportError('source-identity-drift', 'pinned historical source changed before import');
  if (!Array.isArray(options.tasks) || options.tasks.length === 0 || options.tasks.length > current.taskIds.length)
    throw new HistoricalSeedTaskImportError('task-not-authorized', 'nonempty bounded task selection required');
  const allowed = new Set(current.taskIds), selected = new Set<string>();
  for (const task of options.tasks) {
    if (!task || typeof task.id !== 'string' || !allowed.has(task.id) || selected.has(task.id)
      || task.purpose !== 'train' && task.purpose !== 'development')
      throw new HistoricalSeedTaskImportError('task-not-authorized', 'task absent, repeated or purpose not admitted');
    selected.add(task.id);
  }
  // No output CAS writes occur before source identity, grant, destination and task checks above.
  const authority = new HistoricalSeedExperienceSource({ registry: options.source.registry,
    evolutionId: options.source.evolutionId, roundId: options.source.roundId,
    workspaceRoot: options.source.workspaceRoot, authorityId: options.source.authorityId,
    ...(options.source.maxTasks === undefined ? {} : { maxTasks: options.source.maxTasks }) });
  let experienceViewRef: ArtifactRef;
  try { experienceViewRef = await sealExperienceView(options.artifacts, authority, current.selector,
    'research', ['overview', 'task-report']); }
  catch (error) {
    throw new HistoricalSeedTaskImportError('source-identity-drift', `source changed during sealing: ${String(error)}`);
  }
  const prepared = prepareTaskViewFromExperience(options.artifacts, experienceViewRef, options.tasks);
  const taskViewRef = options.taskAuthority.seal(prepared);
  return { selector: current.selector, sourceManifestDigest: current.sourceManifestDigest,
    experienceViewRef, taskViewRef, provenance: 'verified', purpose: 'research' };
}
