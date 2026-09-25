import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { AuthorizedExperienceSources, readExperienceView, sealExperienceView } from '../../src/algorithm/data/experience.js';
import { prepareTaskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { createResearchProfileFromSource, createSealedResearchProfile } from '../../src/algorithm/research-profile.js';
import { jsonDigest } from '../../src/algorithm/schema.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('builds stable, campaign-bound evidence and task providers from an authorized sealed view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-research-profile-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const source = new AuthorizedExperienceSources();
  const selector = { namespace: 'campaign' as const, sourceId: 'seed-fixture',
    cursor: { namespace: 'campaign:seed-fixture', value: 'frozen' } };
  source.registerVerified({ selector, sourceManifestDigest: jsonDigest('test-seed'),
    indexVersion: 'fixture-v1', provenance: 'verified', entries: [{ id: 'task-one', kind: 'task-trajectory',
      taskId: 'task-one', exposure: { seenInTraining: true, graderLabelExposed: false },
      task: { prompt: 'fixture prompt' }, overview: { summary: 'fixture', tags: [] },
      taskReport: { narrative: 'fixture report' }, traceChunks: [] },
    { id: 'task-two', kind: 'task-trajectory', taskId: 'task-two',
      exposure: { seenInTraining: true, graderLabelExposed: false }, task: { prompt: 'other fixture prompt' },
      overview: { summary: 'other fixture', tags: [] }, taskReport: { narrative: 'other report' }, traceChunks: [] }] },
  { purpose: 'research', authorityId: 'host-test', projections: ['overview', 'task-report'], exposeGraderLabels: false },
  () => undefined);
  const viewRef = await sealExperienceView(artifacts, source, selector, 'research', ['overview', 'task-report']);
  const context = { campaignId: 'research-test', configDir: root, stateDir: join(root, 'state'),
    config: {}, budget: {}, artifacts };
  const first = createSealedResearchProfile(context, { authorizedExperienceViewRef: viewRef,
    authorityId: 'host-test', allowedTaskIds: ['task-one'] });
  const second = createSealedResearchProfile(context, { authorizedExperienceViewRef: viewRef,
    authorityId: 'host-test', allowedTaskIds: ['task-one'] });
  expect(first.providers.map(provider => provider.describe().kind)).toEqual([
    'evidence.query', 'evidence.read', 'tasks.select', 'tasks.consume']);
  expect(first.providers.map(provider => provider.describe().implementationDigest))
    .toEqual(second.providers.map(provider => provider.describe().implementationDigest));
  expect(first.campaignGrant.viewDigests).toEqual([viewRef.digest]);
  expect((await stat(join(root, 'state/host-authority/tasks.key'))).mode & 0o777).toBe(0o600);
  const unauthorizedViewRef = first.taskAuthority.seal(prepareTaskViewFromExperience(artifacts, viewRef,
    [{ id: 'task-two', purpose: 'development' }]));
  expect(() => first.providers[2]!.preflight({ kind: 'tasks.select', input: { experienceViewRef: viewRef,
    tasks: [{ id: 'task-two', purpose: 'development' }] } } as never)).toThrow('selection exceeds task grant');
  expect(() => first.providers[3]!.preflight({ kind: 'tasks.consume', input: { taskViewRef: unauthorizedViewRef,
    cursor: { viewDigest: unauthorizedViewRef.digest, nextIndex: 0 }, count: 1 } } as never))
    .toThrow('consumption exceeds task grant');
  expect(() => createSealedResearchProfile(context, { authorizedExperienceViewRef: viewRef,
    authorityId: 'host-test', allowedTaskIds: ['unknown'] })).toThrow('grant exceeds sealed view');
});

it('resumes against the pinned research view when the source later appends history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-research-pin-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const registered = new AuthorizedExperienceSources();
  const selectors = [1, 2].map(index => ({ namespace: 'campaign' as const, sourceId: 'appendable',
    cursor: { namespace: 'campaign:appendable', value: `history-${index}` } }));
  for (const [index, selector] of selectors.entries()) registered.registerVerified({ selector,
    sourceManifestDigest: jsonDigest({ index }), indexVersion: 'fixture-v1', provenance: 'verified',
    entries: [{ id: 'task-one', kind: 'task-trajectory', taskId: 'task-one',
      exposure: { seenInTraining: true, graderLabelExposed: false },
      task: { prompt: `fixture ${index}` }, overview: { summary: 'fixture', tags: [] },
      taskReport: { narrative: `fixture ${index}` }, traceChunks: [] }] },
  { purpose: 'research', authorityId: 'appendable-host', projections: ['overview', 'task-report'],
    exposeGraderLabels: false }, () => undefined);
  let current = 0;
  let selections = 0;
  const source = { selector: async () => { selections++; return selectors[current]!; },
    resolve: (selector: typeof selectors[number], purpose: 'research' | 'evaluation') =>
      registered.resolve(selector, purpose) };
  const context = { campaignId: 'pinned-research', configDir: root, stateDir: join(root, 'state'),
    config: {}, budget: {}, artifacts };
  const first = await createResearchProfileFromSource(context, { source, authorityId: 'appendable-host' });
  current = 1;
  const resumed = await createResearchProfileFromSource(context, { source, authorityId: 'appendable-host' });
  expect(resumed.experienceViewRef).toEqual(first.experienceViewRef);
  expect(await readFile(join(root, 'state/host-authority/research-view.json'), 'utf8')).toContain('history-1');
  expect(readExperienceView(artifacts, resumed.experienceViewRef).source).toEqual(selectors[0]);
  expect(selections).toBe(1);
  expect(() => createSealedResearchProfile(context, { authorizedExperienceViewRef: first.experienceViewRef,
    authorityId: 'different-host' })).toThrow('verified label-free');
});
