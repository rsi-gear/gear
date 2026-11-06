#!/usr/bin/env node
// Compare two pre-registered, already authored methods using Gear's real staged
// search engine. For autonomous candidate authoring use start.mjs + the Meta host.
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { cli, command, isMain } from '../kaggle-titanic/common.mjs'
import { Store, json, locked } from './lib/store.mjs'
import { assert, digest, seal, sha } from './lib/contracts.mjs'
import { buildControl } from './start.mjs'
import { FailureClusterSearch } from '../../lib/search/engine.js'
import { SearchStore } from '../../lib/search/store.js'
import { consumptionReceipt } from '../../lib/search/diagnosis.js'
import { resolveSearchSettings } from '../../lib/search/config.js'

export async function compareRegistered(directory, base, stageId) {
  const project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const stage = await store.load('stages', stageId)
  assert(stage?.plan.harnesses.length === 2, 'comparison requires two pre-registered harnesses')
  const [reference, candidate] = stage.plan.harnesses
  const built = await buildControl(base, project, directory, { checkpointRef: stage.plan.checkpointRef, fromHarness: reference })
  const git = args => command('git', args, { cwd: project.targetRepository })
  const snapshot = async (h, candidateId, parentIds = []) => seal({ candidateId, commit: h.commit,
    tree: await git(['rev-parse', `${h.commit}^{tree}`]), manifestDigest: h.manifestDigest, parentIds, findingRefs: [] })
  const anchor = await snapshot(reference, 'reference'), revision = digest({ stage: stage.plan.digest, anchor: anchor.digest })
  const hooks = {
    async verifySnapshot(s) {
      assert(stage.plan.harnesses.some(h => h.commit === s.commit && h.manifestDigest === s.manifestDigest), 'unregistered harness')
      assert(await git(['rev-parse', `${s.commit}^{tree}`]) === s.tree, 'source tree changed')
      const m = JSON.parse(await git(['show', `${s.commit}:harness/manifest.json`]))
      const body = { schemaVersion: 1, ...(m.parentRef === undefined ? {} : { parentRef: m.parentRef }), dshBaseRef: m.dshBaseRef,
        toolchainRef: m.toolchainRef, sandboxProfileRef: m.sandboxProfileRef, artifacts: m.artifacts }
      assert(m.digest === s.manifestDigest && sha(JSON.stringify(body)) === m.digest, 'manifest identity changed')
      for (const f of m.artifacts) {
        const { stdout } = await promisify(execFile)('git', ['show', `${s.commit}:harness/${f.path}`], { cwd: project.targetRepository, encoding: 'buffer', maxBuffer: 16777216 })
        assert(stdout.length === f.bytes && sha(stdout) === f.digest, 'harness artifact changed')
      }
    },
    async generate({ delivery, parent, idempotencyKey }) {
      const previous = await store.load('proposals', idempotencyKey.slice(7)); if (previous) return previous
      assert(delivery.dossier.facts.length > 0, 'missing actual seed evidence')
      const sessionId = `registered-method-review-${stageId}`
      const result = seal({ snapshot: await snapshot(candidate, delivery.workplan.candidateId, [parent.candidateId]),
        changedPaths: (await git(['diff', '--name-only', reference.commit, candidate.commit])).split('\n').filter(Boolean),
        receipt: consumptionReceipt(delivery, sessionId, delivery.workplan.requiredDiagnosisRefs), sessionId,
        usage: { tokens: 0, requests: 0 } })
      await store.save('proposals', idempotencyKey.slice(7), result); return result
    },
    async inspectGeneration(key) {
      const result = await store.load('proposals', key.slice(7)); return result ? { status: 'complete', result } : { status: 'not-started' }
    },
    async commitChampion(expected, next) {
      await locked(store.path('locks', `${stageId}-champion`), async () => {
        const previous = await store.load('champions', stageId)
        if (previous?.commit === next.commit) return
        assert(expected === revision && !previous, 'champion revision changed')
        await store.save('champions', stageId, { previousRevisionDigest: expected, ...next })
      })
    },
  }
  const search = new FailureClusterSearch(new SearchStore(join(built.cohort, 'registered-comparison', stageId)), built.provider, built.provider.diagnosis, hooks)
  const outcome = await search.run({ evolutionId: `${project.projectId}-${stageId}`, roundId: stageId, roundIndex: 0,
    maxCandidates: 1, anchor, championRevisionDigest: revision, settings: resolveSearchSettings(built.config) }, new AbortController().signal)
  const result = { outcome, adoptedCommit: outcome.championChanged ? candidate.commit : reference.commit,
    authoring: 'pre-registered methods; no autonomous Meta generation claimed', heldOutRuns: 0 }
  await store.save('comparisons', stageId, result); return result
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, config: { type: 'string' }, stage: { type: 'string' } } })
  assert(v.project && v.config && v.stage, '--project, --config and --stage required')
  console.log(JSON.stringify(await compareRegistered(resolve(v.project), await json(resolve(v.config)), v.stage), null, 2))
}
if (isMain(import.meta.url)) cli(main)
