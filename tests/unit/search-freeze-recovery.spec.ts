import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { fixtures, settings } from '../helpers/search-fixture.js'
import type { StageEvaluationPlan, StageResult } from '../../src/search/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('search journal freeze boundaries', () => {
  it.each(['planning', 'generated', 'local', 'local-stage-decisions', 'expansion', 'nomination', 'research', 'commit', 'champion', 'terminal',
    'rung:baseline-probe', 'rung:local', 'rung:bridge', 'rung:global-seed', 'rung:held-out'])('[R02,R08] recovers a crash after the %s pointer is durable', async point => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-freeze-')); roots.push(root)
    const store = new SearchStore(root), write = store.write.bind(store)
    let interrupted = false
    store.write = async (name, value) => {
      await write(name, value)
      let matches = point === 'generated' ? name.startsWith('rounds/r/generated-') : name === `rounds/r/${point}`
      if (point.startsWith('rung:') && /^rounds\/r\/evaluation-[a-f0-9]+$/u.test(name)) {
        const result = await store.object<StageResult>((value as { ref: string }).ref)
        const plan = await store.object<StageEvaluationPlan>(result.stagePlanDigest)
        matches = plan.stage === point.slice(5) && (plan.stage === 'baseline-probe' || result.snapshotDigest !== f.anchor.digest)
      }
      if (!interrupted && matches) { interrupted = true; throw new Error('crash after durable pointer') }
    }
    const commit = f.hooks.commitChampion
    f.hooks.commitChampion = async (...args) => {
      await commit(...args)
      if (!interrupted && point === 'champion') { interrupted = true; throw new Error('crash after durable pointer') }
    }
    const request = { evolutionId: 'freeze', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
    const run = () => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run(request, new AbortController().signal)
    await expect(run()).rejects.toThrow('crash after durable pointer')
    expect(interrupted).toBe(true)
    const parents = await store.read('rounds/r/parents'), planning = await store.read('rounds/r/planning'), executionCount = f.executions.length
    const result = await run()
    expect(result.championChanged).toBe(true)
    if (parents) expect(await store.read('rounds/r/parents')).toEqual(parents)
    if (planning) expect(await store.read('rounds/r/planning')).toEqual(planning)
    expect(f.generated).toHaveLength(4)
    expect(new Set(f.generated).size).toBe(4)
    expect(f.executions.length).toBe(new Set(f.executions.map(e => e.key)).size)
    expect(f.promotions).toHaveLength(1)
    if (point === 'commit' || point === 'champion' || point === 'terminal') expect(f.executions).toHaveLength(executionCount)
    expect(await store.read('active-round')).toEqual({ roundId: null })
    expect(await run()).toEqual(result)
  })
})
