#!/usr/bin/env node
import { readFile, copyFile, constants, mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { cli, isMain } from '../kaggle-titanic/common.mjs'
import { validateTabularSubmission } from './lib/submission.mjs'
import { Store, json, atomicJson, locked, optionalJson } from './lib/store.mjs'
import { assert, digest, seal, sha, verify } from './lib/contracts.mjs'
import { HitchBackend, refitBinding } from './lib/hitch-backend.mjs'
import { ResearchProject } from './lib/project.mjs'
import { withinDeadline, withOperatorCancellation } from './lib/deadline.mjs'

export async function refit(store, backend, project, receipt, out, { signal } = {}) {
  verify(receipt)
  return locked(store.path('locks', `refit-${receipt.digest.slice(7)}`), () => refitLocked(store, backend, project, receipt, out, { signal }))
}

async function refitLocked(store, backend, project, receipt, out, { signal } = {}) {
  const state = await store.load('sequences', receipt.planDigest.slice(7))
  assert(state?.receipt?.digest === receipt.digest && receipt.delivery.status === 'completed', 'refit requires the actual valid C5 from the nominated sequence')
  assert(state.plan.task.digest === project.task.digest && state.plan.runtimeDigest === project.task.runtimeDigest
    && digest(state.plan.budget) === digest(project.budget) && state.plan.harness.commit === receipt.harness.commit
    && state.plan.harness.manifestDigest === receipt.harness.manifestDigest, 'refit source differs from the registered task, budget, runtime or harness')
  assert(receipt.selections[4].incumbentSolutionDigest === receipt.delivery.solutionDigest, 'delivery is not C5')
  const inputs = await refitBinding(project.backend), frozen = await store.load('bindings', 'refit')
  assert(frozen?.digest === inputs.digest, 'full-training or prediction inputs changed; refit requires its prepared input binding')
  await backend.admit(state.plan)
  await backend.verifyReceipt(receipt)
  const checkpoint = await store.get(receipt.checkpointRef), solution = checkpoint.solutions.find(s => s.digest === receipt.delivery.solutionDigest)
  assert(solution?.protocol === 'analysis-solution@2', 'refit requires a resolved pipeline; legacy search programs must be migrated in a new research experiment')
  const selectionPlan = seal({ protocol: 'analysis-source-selection@1', sequencePlanDigest: state.plan.digest,
    sourceSequenceReceiptDigest: receipt.digest, startingCheckpointDigest: receipt.startingCheckpointDigest,
    harness: receipt.harness, runtimeDigest: state.plan.runtimeDigest, budgetDigest: digest(state.plan.budget),
    childRuns: receipt.steps, sourceRunId: receipt.delivery.runId, outputManifestDigest: receipt.delivery.outputManifestDigest, solutionDigest: solution.digest })
  const task = seal({ ...Object.fromEntries(Object.entries(project.task).filter(([k]) => k !== 'digest')),
    taskId: `${project.task.taskFamilyId}-refit`, inputs: inputs.inputs,
    predictIds: project.backend.refit.predictIds })
  const request = seal({ protocol: 'analysis-refit-request@1', task, solution, runtimeDigest: state.plan.runtimeDigest,
    harness: receipt.harness, sourceSelectionPlan: selectionPlan, allowance: { wallSeconds: 300, cpuSeconds: 600, tokens: 0, requests: 0, tools: 0 } })
  const published = await optionalJson(join(out, 'refit.json'))
  if (published) { verify(published); assert(published.requestDigest === request.digest, 'export directory belongs to another refit') }
  const controller = new ResearchProject(store, project), id = request.digest.slice(7)
  await controller.reserveAuxiliary('deployments', request.digest, { wallSeconds: 300, cpuSeconds: 600 })
  const previous = await store.load('refits', id)
  if (previous) { verify(previous); assert(previous.requestDigest === request.digest, 'refit request changed') }
  let attempt = await store.load('refit-attempts', id)
  if (!attempt) {
    // Older interrupted exports have no start timestamp. Keep their full wall
    // reservation rather than treating the inspection time as execution cost.
    attempt = { startedAt: Date.now(), recoveredWithoutStart: !!await store.load('executions', id) }
    await store.save('refit-attempts', id, attempt)
  }
  const recorded = await store.load('executions', id)
  const delivered = previous?.delivery ?? (recorded?.status === 'complete' ? await backend.deliver(request, { signal })
    : await withinDeadline(backend, request, attempt.startedAt + request.allowance.wallSeconds * 1000,
      signal => backend.deliver(request, { signal }), { signal }))
  assert(delivered.modelRequests === 0 && delivered.solutionDigest === solution.digest, 'refit changed source or invoked a model')
  assert(delivered.resolvedPipelineDigest === solution.parameters.digest && delivered.searchCalls === 0
    && (delivered.status !== 'completed' || delivered.fits === 1), 'refit did not execute the frozen fit-only configuration')
  const wallSeconds = attempt.recoveredWithoutStart ? request.allowance.wallSeconds
    : Math.min(request.allowance.wallSeconds, (Date.now() - attempt.startedAt) / 1000)
  if (delivered.status !== 'completed') {
    assert(delivered.status === 'candidate_failed', 'refit outcome is unavailable; preserve its reservation')
    const result = previous ?? seal({ protocol: 'analysis-refit-result@1', requestDigest: request.digest, selectionPlan,
      delivery: delivered, submissionDigest: null, rows: 0, accuracy: null, cost: delivered.cost, wallSeconds })
    await store.save('refits', id, result)
    await mkdir(out, { recursive: true }); await atomicJson(join(out, 'refit.json'), result)
    await controller.settleAuxiliary('deployments', request.digest, result)
    throw new Error('selected solution failed refit; no alternate source may be chosen automatically')
  }
  const op = await store.load('executions', request.digest.slice(7)), source = join(op.destination, 'output/predictions.csv'), bytes = await readFile(source)
  validateTabularSubmission(bytes, task)
  await mkdir(out, { recursive: true })
  try { await copyFile(source, join(out, 'submission.csv'), constants.COPYFILE_EXCL) }
  catch (e) { if (e.code !== 'EEXIST' || sha(await readFile(join(out, 'submission.csv'))) !== sha(bytes)) throw e }
  const result = previous ?? seal({ protocol: 'analysis-refit-result@1', requestDigest: request.digest, selectionPlan,
    delivery: delivered, submissionDigest: sha(bytes), rows: task.predictIds.length, accuracy: null, cost: delivered.cost,
    wallSeconds })
  assert(result.delivery.digest === delivered.digest && result.submissionDigest === sha(bytes), 'refit evidence changed')
  await store.save('refits', id, result)
  await atomicJson(join(out, 'refit.json'), result); await controller.settleAuxiliary('deployments', request.digest, result)
  return result
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, sequence: { type: 'string' }, out: { type: 'string' } } })
  assert(v.project && v.sequence && v.out, '--project, --sequence and --out required')
  const directory = resolve(v.project), project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const state = await store.load('sequences', v.sequence.replace(/^sha256:/, '')); assert(state?.receipt, 'sequence not complete')
  console.log(JSON.stringify(await withOperatorCancellation(signal => refit(store, new HitchBackend(store, project.backend), project, state.receipt, resolve(v.out), { signal })), null, 2))
}
if (isMain(import.meta.url)) cli(main)
