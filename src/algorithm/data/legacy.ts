import type { RefineStateStore } from '../../state/store.js';
import { loadSeedExperienceSnapshot } from '../../experience/memory.js';
import type { SeedExperienceRecord } from '../../types.js';
import { jsonDigest } from '../schema.js';
import { s3ImplementationDigest } from './identity.js';
import { validateSelector, type ExperiencePurpose, type ExperienceSourceAuthority, type SourceExperience, type SourceGrant,
  type SourceSelector, type SourceSnapshot } from './experience.js';

function oldDigest(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error('Invalid sealed legacy snapshot digest');
  return value.slice('sha256:'.length);
}

/** Host-bound read-only bridge to the old, validated evolution state store. */
export class LegacyEvolutionExperienceSource implements ExperienceSourceAuthority {
  constructor(readonly store: RefineStateStore, readonly evolutionId: string, readonly snapshotRoundId: string,
    readonly authorityId: string) {
    if (!authorityId || !evolutionId || !snapshotRoundId || store.evolutionId !== evolutionId) throw new Error('Legacy source authority mismatch');
  }

  async selector(): Promise<SourceSelector> {
    const round = await this.store.readRound(this.snapshotRoundId);
    if (!round || round.evolutionId !== this.evolutionId || !round.experienceSnapshot) throw new Error('Sealed legacy experience snapshot unavailable');
    const selector: SourceSelector = { namespace: 'legacy-evolution', sourceId: this.evolutionId,
      cursor: { namespace: `legacy-evolution:${this.evolutionId}`, value: oldDigest(round.experienceSnapshot.digest) } };
    validateSelector(selector);
    return selector;
  }

  async resolve(selector: SourceSelector, purpose: ExperiencePurpose): Promise<{ snapshot: SourceSnapshot; grant: SourceGrant }> {
    const pinned = await this.selector();
    if (jsonDigest(selector) !== jsonDigest(pinned)) throw new Error('Legacy experience cursor changed');
    const round = await this.store.readRound(this.snapshotRoundId);
    if (!round?.experienceSnapshot) throw new Error('Sealed legacy experience snapshot unavailable');
    const loaded = await loadSeedExperienceSnapshot(this.store, round.experienceSnapshot);
    if (loaded.unavailableRecordIds.length) throw new Error('Sealed legacy experience record unavailable');
    const entries = loaded.records.map(record => projectSeedRecord(record));
    const grant: SourceGrant = { authorityId: this.authorityId, purpose,
      projections: ['overview', 'task-report', 'trace-chunk'], exposeGraderLabels: false };
    return { snapshot: { selector: pinned, sourceManifestDigest: oldDigest(round.experienceSnapshot.digest),
      indexVersion: s3ImplementationDigest('legacy-seed-index', { oldSnapshotSchemaVersion: 1 }), entries, provenance: 'verified' }, grant };
  }
}

/** Strict allowlist: no held-out result, individual reward, grader label or private feedback. */
function projectSeedRecord(record: SeedExperienceRecord): SourceExperience {
  const source = record.source;
  return { id: record.recordId, kind: 'seed-summary',
    exposure: { seenInTraining: true, graderLabelExposed: false },
    overview: { summary: `Candidate ${source.candidateId} in round ${source.roundId} has a sealed seed proposal`,
      tags: [...record.proposal.semanticTargets] },
    taskReport: { narrative: `Proposer claim: ${record.proposal.rationale}. Expected outcome claim: ${record.proposal.expectedOutcome}.` },
    traceChunks: [] };
}
