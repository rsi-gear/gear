import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EvolutionRegistryStore } from '../../src/state/evolution.js';
import { digestJson } from '../../src/state/digest.js';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { readExperienceView } from '../../src/algorithm/data/experience.js';
import { TaskViewAuthority, readTaskView } from '../../src/algorithm/data/tasks.js';
import { inspectHistoricalSeedTaskSource, importHistoricalSeedTaskView,
  type HistoricalSeedTaskSource } from '../../src/history/experience.js';
import { evolutionSpec, roundFixture } from '../helpers/research-fixture.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import type { EvaluationCondition, RefinementRound } from '../../src/types.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(options: { externalSeed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gear-history-experience-'));
  paths.push(root);
  const workspaceRoot = join(root, 'workspace');
  const seed = await standardSearchDataset(options.externalSeed ? join(root, 'external') : workspaceRoot, 2, 'seed');
  const seedRef = options.externalSeed ? seed.ref : 'seed';
  const held = await standardSearchDataset(workspaceRoot, 1, 'held-out');
  const spec = { ...evolutionSpec(), datasets: { seed: { ref: seedRef, digest: seed.digest },
    heldOut: { ref: 'held-out', digest: held.digest } } };
  const registry = new EvolutionRegistryStore(join(root, 'registry'));
  await registry.createEvolution({ spec, champion: { schemaVersion: 2, ref: spec.initialHarness.ref,
    manifestDigest: spec.initialHarness.digest, updatedAt: 'now' } });
  const base = roundFixture({ workspaceRoot, seedTaskRef: seedRef, heldOutRef: 'held-out' });
  function condition(original: EvaluationCondition, dataset: { ref: string; digest: string }): EvaluationCondition {
    const { conditionId: ignored, ...body } = original;
    return { ...body, dataset, conditionId: digestJson({ ...body, dataset }) };
  }
  const seedCondition = condition(base.plan.seed, { ref: seedRef, digest: seed.digest });
  const heldCondition = condition(base.plan.heldOut, { ref: 'held-out', digest: held.digest });
  const plan = { ...base.plan, seed: seedCondition, heldOut: heldCondition,
    digest: digestJson({ roundId: base.roundId, taskSampler: base.plan.taskSampler,
      seed: seedCondition, heldOut: heldCondition }) };
  const round: RefinementRound = { ...base, plan };
  await registry.stateStore(spec.evolutionId).writeRound(round);
  const source: HistoricalSeedTaskSource = { registry, evolutionId: spec.evolutionId, roundId: round.roundId,
    workspaceRoot, authorityId: 'trusted-history' };
  const artifacts = new FileArtifactStore(join(root, 'new-cas'));
  const taskAuthority = new TaskViewAuthority(artifacts, 'new-campaign-task-host', Buffer.alloc(32, 7));
  return { root, registry, spec, round, seed, source, artifacts, taskAuthority };
}
async function treeBytes(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      hash.update(relative(root, child));
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) hash.update(await readFile(child));
      else throw new Error('unexpected special source file');
    }
  }
  await visit(root);
  return hash.digest('hex');
}
const selection = [{ id: 'task-1', purpose: 'development' as const }];

it('pins a verified historical seed source and imports only authorized research tasks without touching old bytes', async () => {
  const f = await fixture();
  // An old readEntry implementation refreshed this file while merely reading a registry entry.
  await writeFile(f.registry.experimentsPath, 'read-only sentinel\n');
  const beforeRegistry = await treeBytes(f.registry.root);
  const beforeWorkspace = await treeBytes(f.source.workspaceRoot);
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  expect(pin).toMatchObject({ schemaVersion: 1, kind: 'historical-seed-task-pin',
    source: { registryRoot: await realpath(f.registry.root), workspaceRoot: await realpath(f.source.workspaceRoot),
      datasetRoot: await realpath(f.seed.ref),
      evolutionId: f.spec.evolutionId, roundId: f.round.roundId },
    selector: { namespace: 'legacy-evolution', sourceId: f.spec.evolutionId },
    taskIds: ['task-0', 'task-1'] });
  const imported = await importHistoricalSeedTaskView({ source: f.source, pin,
    artifacts: f.artifacts, taskAuthority: f.taskAuthority, tasks: selection });
  expect(imported).toMatchObject({ provenance: 'verified', purpose: 'research', selector: pin.selector,
    sourceManifestDigest: pin.sourceManifestDigest });
  const experience = readExperienceView(f.artifacts, imported.experienceViewRef);
  expect(experience).toMatchObject({ provenance: 'verified', purpose: 'research', labelsExposed: false,
    authorityId: 'trusted-history', projections: ['overview', 'task-report'] });
  expect(experience.entries.every(entry => entry.kind === 'task-trajectory'
    && entry.exposure.seenInTraining && !entry.exposure.graderLabelExposed
    && entry.traceRefs === undefined)).toBe(true);
  const taskView = f.taskAuthority.verify(imported.taskViewRef, [imported.experienceViewRef.digest]);
  expect(taskView.tasks).toHaveLength(1);
  expect(taskView.tasks[0]).toMatchObject({ id: 'task-1', purpose: 'development',
    exposure: { seenInTraining: true, graderLabelExposed: false } });
  expect(f.artifacts.getJson(taskView.tasks[0]!.contentRef)).toMatchObject({
    prompt: 'seed fixture task 1\n', executionSource: { kind: 'compiled-seed-dataset', datasetDigest: f.seed.digest } });
  expect(await treeBytes(f.registry.root)).toBe(beforeRegistry);
  expect(await treeBytes(f.source.workspaceRoot)).toBe(beforeWorkspace);
  expect(await readFile(f.registry.experimentsPath, 'utf8')).toBe('read-only sentinel\n');
});

it('readEntry with a missing registry is read-only and does not create an index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-history-missing-registry-'));
  paths.push(root);
  const registry = new EvolutionRegistryStore(join(root, 'missing'));
  expect(await registry.readEntry('known')).toBeUndefined();
  await expect(stat(registry.root)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(registry.experimentsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['registry', 'spec', 'round'] as const)('refuses missing %s instead of manufacturing verified history', async missing => {
  const f = await fixture();
  if (missing === 'registry') await rm(f.registry.registryPath);
  else if (missing === 'spec') await rm(join(f.registry.evolutionRoot(f.spec.evolutionId), 'spec.json'));
  else await rm(join(f.registry.evolutionRoot(f.spec.evolutionId), 'rounds', `${f.round.roundId}.json`));
  const before = await treeBytes(f.registry.root);
  await expect(inspectHistoricalSeedTaskSource(f.source)).rejects.toMatchObject({ code: 'source-verification-failed' });
  expect(await treeBytes(f.registry.root)).toBe(before);
});

it('rejects changed dataset bytes against a pin before writing destination artifacts', async () => {
  const f = await fixture();
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  await writeFile(join(f.seed.ref, 'task-0', 'instruction.md'), 'changed\n');
  const before = await readdir(join(f.artifacts.root, 'objects'));
  await expect(importHistoricalSeedTaskView({ source: f.source, pin, artifacts: f.artifacts,
    taskAuthority: f.taskAuthority, tasks: selection })).rejects.toMatchObject({ code: 'source-identity-drift' });
  expect(await readdir(join(f.artifacts.root, 'objects'))).toEqual(before);
});

it('rejects forged source pin, unknown/final-test tasks and another CAS authority before writing artifacts', async () => {
  const f = await fixture();
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  const before = await readdir(join(f.artifacts.root, 'objects'));
  const request = { source: f.source, pin, artifacts: f.artifacts, taskAuthority: f.taskAuthority, tasks: selection };
  await expect(importHistoricalSeedTaskView({ ...request, pin: { ...pin, sourceManifestDigest: '0'.repeat(64) } }))
    .rejects.toMatchObject({ code: 'source-identity-drift' });
  await expect(importHistoricalSeedTaskView({ ...request, tasks: [{ id: 'missing', purpose: 'development' }] }))
    .rejects.toMatchObject({ code: 'task-not-authorized' });
  await expect(importHistoricalSeedTaskView({ ...request, tasks: [{ id: 'task-1', purpose: 'final-test' }] as never }))
    .rejects.toMatchObject({ code: 'task-not-authorized' });
  await expect(importHistoricalSeedTaskView({ ...request, tasks: [...selection, ...selection] }))
    .rejects.toMatchObject({ code: 'task-not-authorized' });
  const anotherCas = new FileArtifactStore(join(f.root, 'other-cas'));
  const anotherAuthority = new TaskViewAuthority(anotherCas, 'different-campaign', Buffer.alloc(32, 9));
  await expect(importHistoricalSeedTaskView({ ...request, taskAuthority: anotherAuthority }))
    .rejects.toMatchObject({ code: 'destination-authority-mismatch' });
  expect(await readdir(join(f.artifacts.root, 'objects'))).toEqual(before);
});

it('refuses an overlapping source/destination CAS and task-only caller attempts to request trajectories', async () => {
  const f = await fixture();
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  const sourceCas = new FileArtifactStore(join(f.source.workspaceRoot, 'new-cas'));
  const sourceAuthority = new TaskViewAuthority(sourceCas, 'bad-campaign', Buffer.alloc(32, 5));
  await expect(importHistoricalSeedTaskView({ source: f.source, pin, artifacts: sourceCas,
    taskAuthority: sourceAuthority, tasks: selection })).rejects.toMatchObject({ code: 'destination-overlap' });
  await expect(inspectHistoricalSeedTaskSource({ ...f.source, evaluationId: 'old-evaluation' } as never))
    .rejects.toMatchObject({ code: 'source-invalid' });
  expect(await readdir(join(sourceCas.root, 'objects'))).toEqual([]);
});

it('refuses destination CAS inside an absolute seed dataset outside the workspace root', async () => {
  const f = await fixture({ externalSeed: true });
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  expect(pin.source.datasetRoot).toBe(await realpath(f.seed.ref));
  const sourceCas = new FileArtifactStore(join(f.seed.ref, 'new-cas'));
  const sourceAuthority = new TaskViewAuthority(sourceCas, 'bad-campaign', Buffer.alloc(32, 5));
  await expect(importHistoricalSeedTaskView({ source: f.source, pin, artifacts: sourceCas,
    taskAuthority: sourceAuthority, tasks: selection })).rejects.toMatchObject({ code: 'destination-overlap' });
  expect(await readdir(join(sourceCas.root, 'objects'))).toEqual([]);
});

it('rejects a destination objects symlink before it can write through into old source', async () => {
  const f = await fixture();
  const pin = await inspectHistoricalSeedTaskSource(f.source);
  const objectPath = join(f.artifacts.root, 'objects');
  await rm(objectPath, { recursive: true });
  await symlink(f.seed.ref, objectPath, 'dir');
  const before = await treeBytes(f.source.workspaceRoot);
  await expect(importHistoricalSeedTaskView({ source: f.source, pin, artifacts: f.artifacts,
    taskAuthority: f.taskAuthority, tasks: selection })).rejects.toMatchObject({ code: 'destination-overlap' });
  expect(await treeBytes(f.source.workspaceRoot)).toBe(before);
});

it('does not turn a record-only failed round into an authorized task source without registry/spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-history-record-only-'));
  paths.push(root);
  const registry = new EvolutionRegistryStore(join(root, 'old-state'));
  await rm(registry.root, { recursive: true, force: true });
  const source = { registry, evolutionId: 'old-evolution', roundId: 'old-failed-round',
    workspaceRoot: root, authorityId: 'trusted-history' };
  await expect(inspectHistoricalSeedTaskSource(source)).rejects.toMatchObject({ code: 'source-verification-failed' });
  await expect(stat(registry.root)).rejects.toMatchObject({ code: 'ENOENT' });
});
