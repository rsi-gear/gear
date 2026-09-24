import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvolutionSpec } from '../../types.js';
import { digestJson } from '../../state/digest.js';
import { digestDatasetRef } from '../../state/dataset.js';
import { describeDataset } from '../../search/dataset-projection.js';
import { sanitizePublicValue } from '../../meta/sanitize.js';
import { canonicalJson, jsonDigest } from '../schema.js';
import { validateSelector, type ExperiencePurpose, type ExperienceSourceAuthority,
  type SourceExperience, type SourceGrant, type SourceSelector, type SourceSnapshot } from './experience.js';

export type FreshSeedSourceOptions = { spec: EvolutionSpec; campaignId: string; workspaceRoot: string;
  authorityId: string; maxTasks?: number };

/** Capture a verified compiled seed dataset as a Campaign-owned, task-only experience snapshot. */
export class FreshSeedExperienceSource implements ExperienceSourceAuthority {
  constructor(readonly options: FreshSeedSourceOptions) {
    if (!options.campaignId || !options.workspaceRoot || !options.authorityId) throw new Error('Fresh seed source host identity required');
  }

  private async capture(): Promise<SourceSnapshot> {
    const { spec, workspaceRoot, campaignId } = this.options;
    const description = await describeDataset(spec, 'seed', workspaceRoot);
    if (description.sourceDigest !== spec.datasets.seed.digest
      || description.universe.tasks.length > (this.options.maxTasks ?? 1_000)) {
      throw new Error('Fresh seed dataset unavailable or too large');
    }
    const entries: SourceExperience[] = [];
    for (const item of description.universe.tasks) {
      const instructionPath = join(description.root, item.id, 'instruction.md');
      const stat = await lstat(instructionPath).catch(() => { throw new Error(`Fresh task instruction unavailable: ${item.id}`); });
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`Fresh task instruction invalid: ${item.id}`);
      const raw = await readFile(instructionPath, 'utf8');
      const prompt = sanitizePublicValue(raw, spec.datasets.heldOut.ref, []);
      if (typeof prompt !== 'string') throw new Error(`Fresh task instruction projection invalid: ${item.id}`);
      entries.push({ id: item.id, kind: 'task-trajectory', taskId: item.id,
        exposure: { seenInTraining: false, graderLabelExposed: false },
        task: { prompt, executionSource: { kind: 'compiled-seed-dataset',
          datasetDigest: description.sourceDigest, taskContentDigest: item.contentDigest } },
        overview: { summary: `Verified fresh seed task ${item.id}; no physical rollout yet`, tags: ['seed-task'] },
        taskReport: { narrative: `Fresh seed task ${item.id}, content digest ${item.contentDigest}.\nInstruction:\n${prompt}` },
        traceChunks: [] });
    }
    if (await digestDatasetRef(description.root) !== description.sourceDigest) throw new Error('Fresh seed dataset changed during capture');
    const sourceManifestDigest = jsonDigest({ spec: digestJson(spec), dataset: description.sourceDigest, entries });
    const selector: SourceSelector = { namespace: 'campaign', sourceId: campaignId,
      cursor: { namespace: `campaign:${campaignId}`, value: sourceManifestDigest } };
    validateSelector(selector);
    return { selector, sourceManifestDigest, indexVersion: 'fresh-seed-physical-v1', provenance: 'verified', entries };
  }

  async selector(): Promise<SourceSelector> { return (await this.capture()).selector; }
  async resolve(selector: SourceSelector, purpose: ExperiencePurpose): Promise<{ snapshot: SourceSnapshot; grant: SourceGrant }> {
    const snapshot = await this.capture();
    if (canonicalJson(snapshot.selector) !== canonicalJson(selector)) throw new Error('Fresh seed source cursor changed');
    return { snapshot, grant: { purpose, authorityId: this.options.authorityId,
      projections: ['overview', 'task-report'], exposeGraderLabels: false } };
  }
}
