import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { replaySearchCase } from '../../src/search/shadow.js'
import { validateSearchSchema } from '../../src/search/schema.js'
import type { EvaluationEvidence } from '../../src/types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function evidence(commit: string, outcomes: number[], process: Array<number | undefined>): EvaluationEvidence {
  return { provider: 'historical-provider', conditionId: digestJson('condition'), effectiveConfigDigest: digestJson('config'), evalId: commit, dataset: 'frozen-dataset', requestedCommit: commit, actualCommit: commit, revisionIdentity: commit,
    benchmark: { id: 'case', revision: digestJson('benchmark') }, completeness: 'complete', plannedTrialCount: outcomes.length, primaryReward: 0, summary: { total: outcomes.length, passed: 0, failed: 0, score: 0 }, invalidTrials: [],
    trials: outcomes.map((totalScore, i) => ({ taskName: `task-${i}`, runId: `run-${commit}-${i}`, attempt: 1, status: 'completed', rewards: { reward: totalScore }, scores: { totalScore, normalization: 'standard', ...(process[i] === undefined ? {} : { processScore: process[i] }) } })) }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gear-shadow-')); roots.push(root)
  const paths = [join(root, 'a.json'), join(root, 'b.json')]
  const records = [evidence('a'.repeat(40), [1, 0, 0], [0.8, 0, 0.5]), evidence('b'.repeat(40), [0, 1, 0], [0.4, 1, 0.8])]
  const save = async (index: number, patch: object = {}) => writeFile(paths[index]!, JSON.stringify({ contextDigest: digestJson('context'), evidence: records[index], evidenceHash: `sha256:${createHash('sha256').update(JSON.stringify(records[index])).digest('hex')}`, ...patch }))
  await save(0); await save(1)
  return { paths, records, save }
}
describe('read-only legacy case shadow replay', () => {
  it('[C02] computes observed specialization and regressions without modifying historical bytes or claiming release', async () => {
    const f = await setup(), before = await Promise.all(f.paths.map(path => readFile(path)))
    const report = await replaySearchCase(f.paths[0]!, f.paths[1]!)
    validateSearchSchema('SearchShadowReport', report)
    expect(report).toMatchObject({ advisory: true, championChanged: false, sourceBytesUnchanged: true, heldOut: 'not-evaluated', v2CellReuse: 'not-certified' })
    expect(report.comparison).toMatchObject({ pairedTasks: 3, outcomeImprovedTaskIds: ['task-1'], outcomeRegressedTaskIds: ['task-0'], processImprovedTaskIds: ['task-1', 'task-2'], processRegressedTaskIds: ['task-0'] })
    expect(report.suggestions.every(s => s.advisory)).toBe(true)
    expect(report.suggestions.find(s => s.action === 'no-release-decision')).toBeDefined()
    expect(await Promise.all(f.paths.map(path => readFile(path)))).toEqual(before)
    expect(await replaySearchCase(f.paths[0]!, f.paths[1]!)).toEqual(report)
  })
  it('rejects changed or unpaired identities and does not infer slots from retries', async () => {
    const f = await setup()
    await f.save(1, { evidenceHash: digestJson('wrong') })
    await expect(replaySearchCase(f.paths[0]!, f.paths[1]!)).rejects.toThrow('digest mismatch')
    await f.save(1, { contextDigest: digestJson('other') })
    await expect(replaySearchCase(f.paths[0]!, f.paths[1]!)).rejects.toThrow('conditions differ')
    f.records[1]!.trials[1]!.taskName = 'task-0'; await f.save(1)
    await expect(replaySearchCase(f.paths[0]!, f.paths[1]!)).rejects.toThrow('duplicate/retried')
    f.records[1]!.trials[1]!.taskName = 'different-task'; await f.save(1)
    await expect(replaySearchCase(f.paths[0]!, f.paths[1]!)).rejects.toThrow('manifests differ')
  })
  it('preserves a missing process observation instead of imputing an aggregate', async () => {
    const f = await setup(); delete f.records[1]!.trials[1]!.scores!.processScore; await f.save(1)
    const report = await replaySearchCase(f.paths[0]!, f.paths[1]!)
    expect(report.comparison.missingProcessTaskIds).toEqual(['task-1'])
    expect(report.comparison.candidateProcess).toBeUndefined()
    expect(report.comparison.baselineProcess).toBeUndefined()
    expect(report.comparison.outcomeImprovedTaskIds).toEqual(['task-1'])
  })
})
