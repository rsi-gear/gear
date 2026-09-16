// Teaching component: deterministic elitist selection on one shared seed scope.
// This is a small executable extension example, not the historical staged engine.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { componentRef } from '../../lib/evolution/components.js';
export const implementation = {
  package: 'gear-example-elitist-selector', version: '1.0.0',
  integrity: `sha256:${createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}`,
};
export function registerElitistSelector(registry) {
  const ref = componentRef('candidate-selector', 'example-elitist', implementation, { metric: 'taskSuccessRate' });
  registry.registerCandidateSelector(ref.id, implementation, sealedRef => ({
    ref: sealedRef,
    select({ candidates, survivors, assessment }) {
      if (!Number.isSafeInteger(survivors) || survivors < 1) throw new Error('survivors must be positive');
      const conditions = new Set(candidates.map(c => c.seedEvaluation.conditionId));
      if (conditions.size !== 1 || conditions.has(undefined)) throw new Error('Selection requires one shared evaluation condition');
      for (const c of candidates) {
        const e = c.seedEvaluation;
        const s = e.summary;
        if (!s || e.completeness !== 'complete' || e.invalidTrials?.length !== 0
          || ![s.total, s.passed, s.failed].every(Number.isSafeInteger)
          || s.total < 1 || e.plannedTrialCount !== s.total
          || s.passed < 0 || s.failed < 0 || s.passed + s.failed !== s.total) {
          throw new Error('Every candidate needs complete valid evidence');
        }
      }
      const ranked = [...candidates].sort((a, b) => b.seedEvaluation.summary.passed / b.seedEvaluation.summary.total - a.seedEvaluation.summary.passed / a.seedEvaluation.summary.total || a.candidateId.localeCompare(b.candidateId));
      const unique = ranked.filter((c, i) => ranked.findIndex(p => p.sealedVersion.treeOid === c.sealedVersion.treeOid) === i);
      if (unique.length < survivors) throw new Error('Not enough distinct evaluated candidates');
      return { selectedCandidateIds: unique.slice(0, survivors).map(c => c.candidateId), promotionCandidateId: unique[0].candidateId,
        reason: 'Elitist selection by strict seed pass rate; deterministic ties and tree deduplication', component: sealedRef, assessmentDigest: assessment.digest,
        metrics: Object.fromEntries(unique.map(c => [c.candidateId, c.seedEvaluation.summary.passed / c.seedEvaluation.summary.total])) };
    },
  }));
  return ref;
}
