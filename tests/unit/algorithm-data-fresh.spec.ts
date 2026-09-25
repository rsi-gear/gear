import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FreshSeedExperienceSource } from '../../src/algorithm/data/fresh-seed.js';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { readExperienceView, sealExperienceView } from '../../src/algorithm/data/experience.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('fresh physical seed intake', () => {
  it('seals verified synthetic compiled tasks with real instructions, no trace, and cursor drift refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-fresh-seed-')); roots.push(root);
    const seed = await standardSearchDataset(root, 2, 'seed');
    const held = await standardSearchDataset(root, 1, 'held-out');
    const base = evolutionSpec();
    const spec = { ...base, datasets: { seed: { ref: 'seed', digest: seed.digest },
      heldOut: { ref: 'held-out', digest: held.digest } } };
    const source = new FreshSeedExperienceSource({ spec, campaignId: 'fresh-campaign',
      workspaceRoot: root, authorityId: 'host-seed' });
    const selector = await source.selector();
    const { snapshot } = await source.resolve(selector, 'research');
    expect(snapshot.selector.namespace).toBe('campaign');
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]!.task?.prompt).toBe('seed fixture task 0\n');
    expect(snapshot.entries[0]!.taskReport.narrative).toContain('Instruction:\nseed fixture task 0\n');
    expect(snapshot.entries[0]!.task?.executionSource?.taskContentDigest).toMatch(/^sha256:/u);
    expect(snapshot.entries[0]!.traceChunks).toEqual([]);
    expect(snapshot.entries[0]!.exposure).toEqual({ seenInTraining: false, graderLabelExposed: false });
    const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const ref = await sealExperienceView(artifacts, source, selector, 'research', ['overview', 'task-report']);
    const view = readExperienceView(artifacts, ref);
    expect(view.sourceIndexVersion).toBe('fresh-seed-physical-v1');
    await writeFile(join(seed.ref, 'task-0', 'instruction.md'), 'changed\n');
    await expect(source.resolve(selector, 'research')).rejects.toThrow(/dataset changed|cursor changed/u);
  });

  it('enforces the host task-count cap before sealing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-fresh-seed-')); roots.push(root);
    const seed = await standardSearchDataset(root, 2, 'seed');
    const held = await standardSearchDataset(root, 1, 'held-out');
    const base = evolutionSpec();
    const source = new FreshSeedExperienceSource({ spec: { ...base, datasets: {
      seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } } },
      campaignId: 'fresh-cap', workspaceRoot: root, authorityId: 'host-seed', maxTasks: 1 });
    await expect(source.selector()).rejects.toThrow(/too large/u);
  });
});
