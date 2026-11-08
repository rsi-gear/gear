#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { cli, isMain } from './lib/common.mjs'
import { Store, json } from './lib/store.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { ResearchProject } from './lib/project.mjs'
import { assert, seal, digest, advance, researchOverhead } from './lib/contracts.mjs'
import { sequencePlan, SequenceRunner, validateRollout } from './lib/sequence.mjs'
import { withinDeadline } from './lib/deadline.mjs'
import { roundValidation } from './lib/validation.mjs'

export async function bootstrapCheckpoint(store, backend, project, { signal } = {}) {
  const key = `${project.projectId}-bootstrap`, existing = await store.load('bootstraps', key)
  if (existing?.status === 'complete') {
    if (existing.settlement) await new ResearchProject(store, project).settleAuxiliary('bootstrap', existing.planDigest, existing.settlement)
    else assert((await store.load('ledgers', project.projectId))?.bootstrap[existing.request.planDigest]?.status === 'complete', 'bootstrap settlement requires recovery')
    return existing
  }
  const initial = await store.get(project.checkpointRef)
  await backend.admit({ task: project.task, model: project.model, budget: project.budget, runtimeDigest: project.task.runtimeDigest })
  assert(initial.history.length === 0, 'bootstrap requires the declared empty origin')
  const plan = seal({ protocol: 'analysis-bootstrap-plan@1', checkpointDigest: initial.digest,
    harness: project.harness, model: project.model, task: project.task,
    cpuSeconds: project.budget.experimentCpuSeconds + researchOverhead.cpuSeconds,
    wallSeconds: project.budget.experimentWallSeconds + researchOverhead.wallSeconds })
  const request = existing?.request ?? seal({ protocol: 'analysis-rollout-request@2', maxExperiments: 1, sequenceId: plan.digest.slice(7), slotIndex: 1,
    planDigest: plan.digest, task: project.task, harness: project.harness, model: project.model, runtimeDigest: project.task.runtimeDigest,
    checkpointDigest: initial.digest, checkpointRef: project.checkpointRef, previousRolloutReceiptDigest: null, eligibleSolutionDigests: [],
    ...(roundValidation(project.task, initial.digest) ? { roundValidation: roundValidation(project.task, initial.digest) } : {}),
    allowance: { wallSeconds: plan.wallSeconds, cpuSeconds: plan.cpuSeconds, tools: 30, tokens: null, requests: null },
    experimentWallSeconds: project.budget.experimentWallSeconds, experimentCpuSeconds: project.budget.experimentCpuSeconds })
  const controller = new ResearchProject(store, project)
  await controller.reserveAuxiliary('bootstrap', request.planDigest, { wallSeconds: request.allowance.wallSeconds, cpuSeconds: request.allowance.cpuSeconds })
  const started = existing?.started ?? Date.now()
  await store.save('bootstraps', key, { status: 'running', request, started })
  const result = validateRollout(await withinDeadline(backend, request, started + request.allowance.wallSeconds * 1000,
    signal => backend.rollout(request, initial, { signal }), { signal }), request, initial, [], initial)
  const next = advance(initial, result.experiment, result.solutions, result.selectedSolutionDigest, result.outputManifestDigest)
  const checkpointRef = await store.advanceProject(project.projectId, project.checkpointRef, next,
    { protocol: 'analysis-bootstrap-completion@1', planDigest: request.planDigest, receiptDigest: result.digest })
  const settlement = { cost: result.cost, wallSeconds: (Date.now() - started) / 1000, receiptDigest: result.digest }
  const record = { status: 'complete', request, started, checkpointRef, receipt: result, planDigest: request.planDigest, settlement }
  await store.save('bootstraps', key, record)
  await controller.settleAuxiliary('bootstrap', request.planDigest, settlement)
  return record
}

export async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: 'string' }, stage: { type: 'string' },
    harnesses: { type: 'string' }, commit: { type: 'string' }, reason: { type: 'string' }, 'manifest-digest': { type: 'string' }, adopted: { type: 'string' }, 'decision-ref': { type: 'string' } } })
  assert(v.project, '--project required')
  const directory = resolve(v.project), project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const backend = new HitchBackend(store, project.backend), controller = new ResearchProject(store, project)
  const abort = new AbortController(); const cancel = () => abort.abort(new Error('operator cancelled'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const action = positionals[0]
    if (action === 'bootstrap') { console.log(JSON.stringify(await bootstrapCheckpoint(store, backend, project, { signal: abort.signal }))); return }
    if (action === 'status') { console.log(JSON.stringify({ head: await store.load('projects', project.projectId), ledger: await store.load('ledgers', project.projectId) }, null, 2)); return }
    assert(v.stage, '--stage required')
    if (action === 'plan') { assert(v.harnesses, '--harnesses JSON_FILE required'); console.log(JSON.stringify(await controller.stage(v.stage, await json(resolve(v.harnesses))), null, 2)); return }
    const state = await store.load('stages', v.stage); assert(state, 'plan the stage first')
    const start = await store.get(state.plan.checkpointRef)
    if (action === 'recover-delivery') {
      const harness = state.plan.harnesses.find(h => h.commit === v.commit); assert(harness, 'harness outside stage')
      const plan = sequencePlan({ task: project.task, checkpoint: start, harness, model: project.model, budget: state.plan.budget, research: { maxExperiments: state.plan.experiments }, runtimeDigest: project.task.runtimeDigest })
      const sequence = await store.load('sequences', plan.digest.slice(7))
      assert(sequence?.status === 'selected' && sequence.pending?.request.protocol === 'analysis-delivery-request@1', 'no pending sealed delivery')
      assert(Date.now() < sequence.budget.startedAt + plan.budget.wallSeconds * 1000, 'original sequence deadline expired; cannot reset budget')
      console.log(JSON.stringify(await backend.repairSealed(sequence.pending.request, v.reason))); return
    }
    if (action === 'run') {
      const harness = state.plan.harnesses.find(h => h.commit === (v.commit ?? project.harness.commit)); assert(harness, 'harness outside frozen stage')
      const plan = sequencePlan({ task: project.task, checkpoint: start, harness, model: project.model, budget: state.plan.budget, research: { maxExperiments: state.plan.experiments }, runtimeDigest: project.task.runtimeDigest })
      await controller.reserveSequence(plan)
      const receipt = await new SequenceRunner(store, backend).run(plan, start, { signal: abort.signal })
      await controller.settleSequence(plan, receipt); console.log(JSON.stringify(receipt, null, 2)); return
    }
    if (action === 'merge') {
      assert(v.adopted && v['decision-ref'], 'merge requires --adopted COMMIT and --decision-ref REPORT_JSON_OR_CAS_REF')
      const decisionRef = v['decision-ref'].startsWith('sha256:') ? v['decision-ref'] : await store.put(await json(resolve(v['decision-ref'])))
      const receipts = []
      for (const harness of state.plan.harnesses) {
        const plan = sequencePlan({ task: project.task, checkpoint: start, harness, model: project.model, budget: state.plan.budget, research: { maxExperiments: state.plan.experiments }, runtimeDigest: project.task.runtimeDigest })
        const branch = await store.load('sequences', plan.digest.slice(7)); assert(branch?.receipt, 'all planned branches must be complete')
        await backend.verifyReceipt(branch.receipt); receipts.push(branch.receipt)
      }
      console.log(JSON.stringify({ checkpointRef: await controller.merge(v.stage, receipts, v.adopted, decisionRef) })); return
    }
    throw new Error('action must be bootstrap, status, plan, run or merge')
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
if (isMain(import.meta.url)) cli(main)
