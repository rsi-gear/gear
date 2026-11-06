#!/usr/bin/env node
// Registered authoring only. Python GEPA and the Project runtime own selection and promotion.
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { cli, isMain } from './lib/common.mjs'
import { Store, json, optionalJson, atomicJson, locked } from './lib/store.mjs'
import { assert } from './lib/contracts.mjs'
import { buildProject, retainedHarness, openProjectControl } from './start.mjs'
import { withOperatorCancellation } from './lib/deadline.mjs'

export async function compareRegistered(directory, stageId, { signal } = {}) {
  const store = new Store(join(directory, 'research')), stage = await store.load('stages', stageId)
  assert(stage?.plan.harnesses.length === 2, 'comparison requires two pre-registered harnesses')
  return locked(store.path('locks', `comparison-${stageId}`), async () => {
    const built = await buildProject(directory, { checkpointRef: stage.plan.checkpointRef, registered: stage.plan.harnesses, stageId })
    const control = await openProjectControl(built.cohort)
    try {
      const path = join(built.cohort, 'admission.json')
      const admission = await optionalJson(path) ?? await control.application.admitRefine()
      await atomicJson(path, admission)
      const report = await control.application.resume(admission.runId, signal)
      assert(report.status === 'completed', 'comparison is incomplete; recover the admitted run')
      const harness = await retainedHarness(built, report)
      const result = { report, adoptedCommit: harness.commit, cohort: built.cohort,
        authoring: 'pre-registered methods; no autonomous Meta generation claimed', heldOutRuns: 0 }
      await store.save('comparisons', stageId, result)
      return result
    } finally { await control.dispose() }
  })
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, stage: { type: 'string' } } })
  assert(v.project && v.stage, '--project and --stage required')
  console.log(JSON.stringify(await withOperatorCancellation(signal => compareRegistered(resolve(v.project), v.stage, { signal })), null, 2))
}
if (isMain(import.meta.url)) cli(main)
