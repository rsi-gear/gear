import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunJournal } from '../domain/run.js'
import type { ProjectConfig } from '../domain/project.js'
import { GearError } from '../domain/errors.js'
import { canonicalDigest } from '../domain/canonical.js'
import { TargetStore } from '../adapters/storage/targets.js'
import { targetDiff } from '../adapters/storage/target-diff.js'
import { harnessAdapter } from './harness-adapters.js'
import { runReport } from './report.js'
import { ResearchStore } from '../adapters/storage/research.js'

async function researchSummary(root: string, journal: RunJournal) {
  try {
    const { archive, objects } = await new ResearchStore(
      join(root, '.gear/runs', journal.id, 'research'),
    ).load(journal)
    return {
      status: 'available' as const,
      digest: archive.digest,
      partition: archive.partition,
      candidate_count: objects.filter((object) => object.kind === 'candidate').length,
      evidence_count: objects.filter((object) => object.kind === 'evidence').length,
      decision_count: objects.filter((object) => object.kind === 'decision').length,
      next_action: `gear archive ${journal.id}`,
    }
  } catch (error) {
    return {
      status: 'unavailable' as const,
      partition: 'seed' as const,
      error: error instanceof GearError ? error.code : 'research-unavailable',
    }
  }
}

/** Operator-only report; candidate bytes are never added to algorithm or Meta feedback. */
export async function projectReport(root: string, journal: RunJournal) {
  const report = { ...runReport(journal), research: await researchSummary(root, journal) }
  try {
    const runRoot = join(root, '.gear/runs', journal.id)
    const config = JSON.parse(await readFile(join(runRoot, 'project.json'), 'utf8')) as ProjectConfig
    if (canonicalDigest(config) !== journal.spec.configDigest)
      throw new GearError('project-identity-mismatch', 'Frozen project configuration changed')
    const store = new TargetStore(
      runRoot,
      harnessAdapter(config.target.adapter),
      journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
    )
    const candidate = (id: string) => {
      const value = journal.candidates.find((item) => item.id === id)
      if (!value) throw new GearError('report-candidate-missing', 'Saved report candidate is unavailable')
      return value
    }
    const retained = await targetDiff(store, journal.spec.anchor, candidate(journal.championId))
    const nominee =
      journal.nomineeId === null
        ? null
        : journal.nomineeId === journal.championId
          ? retained
          : await targetDiff(store, journal.spec.anchor, candidate(journal.nomineeId))
    return { ...report, changes: { version: 1 as const, status: 'available' as const, retained, nominee } }
  } catch (error) {
    // Keep budget, failure and recovery information readable when local resources are damaged.
    return {
      ...report,
      changes: {
        version: 1 as const,
        status: 'unavailable' as const,
        error: {
          code: error instanceof GearError ? error.code : 'report-resources-unavailable',
          message: 'Target changes could not be verified against the frozen resources',
        },
      },
    }
  }
}
