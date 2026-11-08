#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { cli, isMain } from './lib/common.mjs'
import { Store, json, locked } from './lib/store.mjs'
import { assert, digest, seal, zeroCost, addCost, validCandidate } from './lib/contracts.mjs'
import { trajectoryReport } from './lib/report.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { ResearchProject } from './lib/project.mjs'
import { withinDeadline, withOperatorCancellation } from './lib/deadline.mjs'
import { isRoundCvTask, experimentValidationDigest } from './lib/validation.mjs'
import { internalScore, internalQuality } from './lib/metrics.mjs'

export async function auditSequence(store, backend, project, receipt, { signal } = {}) {
  return locked(store.path('locks', `audit-${receipt.planDigest.slice(7)}`), () => auditLocked(store, backend, project, receipt, { signal }))
}

async function auditLocked(store, backend, project, receipt, { signal } = {}) {
  const id = receipt.planDigest.slice(7), state = await store.load('sequences', id)
  assert(state?.receipt?.digest === receipt.digest, 'audit requires a sealed original sequence')
  if (isRoundCvTask(state.plan.task)) {
    const experiments = state.steps.map(s => s.experiment).filter(e => validCandidate(e)
      && experimentValidationDigest(e) === digest(state.plan.roundValidation))
    const result = seal({ protocol: 'analysis-audit@1', sequenceReceiptDigest: receipt.digest, selectionDigest: digest(receipt.selections),
      evaluationKind: 'round_five_fold_cv', independentTest: false,
      solutions: Object.fromEntries(experiments.map(e => [e.sourceDigest, { status: 'completed', quality: internalQuality(e),
        accuracy: e.execution.metric === 'accuracy' ? internalScore(e) : null, reusedCv: e.digest }])), cost: zeroCost(), wallSeconds: 0 })
    await store.save('audits', id, { status: 'complete', result })
    return result
  }
  const previous = await store.load('audits', id)
  const controller = new ResearchProject(store, project), checkpoint = await store.get(receipt.checkpointRef)
  if (previous?.status === 'complete') {
    await controller.settleAuxiliary('audit', id, previous.result)
    return previous.result
  }
  const start = await store.get(state.startCheckpointRef)
  assert(start.digest === receipt.startingCheckpointDigest, 'audit starting checkpoint changed')
  const candidates = [...new Set([start.currentSolutionDigest,
    ...state.steps.filter(s => validCandidate(s.experiment)).map(s => s.experiment.sourceDigest)].filter(Boolean))]
  assert(candidates.length <= state.plan.experiments + 1, 'audit candidate coverage exceeds registered plan')
  const perRefit = { wallSeconds: state.plan.budget.reserveSeconds, cpuSeconds: state.plan.budget.reserveCpuSeconds }
  const limits = { wallSeconds: state.plan.experiments * perRefit.wallSeconds, cpuSeconds: state.plan.experiments * perRefit.cpuSeconds }
  let audit = previous ?? { status: 'running', startedAt: Date.now(), solutions: {}, cost: zeroCost(), attempts: 0 }
  await controller.reserveAuxiliary('audit', id, limits)
  await store.save('audits', id, audit)
  for (const sourceDigest of candidates) {
    if (audit.solutions[sourceDigest]) continue
    if (receipt.delivery.status === 'completed' && receipt.delivery.solutionDigest === sourceDigest) {
      audit.solutions[sourceDigest] = { status: 'completed', quality: receipt.delivery.quality, accuracy: receipt.delivery.accuracy, reusedDelivery: receipt.delivery.digest }
      continue
    }
    const wall = limits.wallSeconds - (Date.now() - audit.startedAt) / 1000, cpu = limits.cpuSeconds - audit.cost.cpuSeconds
    if (!audit.pending && (wall <= 0 || cpu < 1 || audit.attempts >= state.plan.experiments)) { audit.solutions[sourceDigest] = { status: 'unavailable', reason: 'audit budget exhausted' }; continue }
    const request = audit.pending?.request ?? seal({ protocol: 'analysis-audit-request@1', sequenceId: id, planDigest: receipt.planDigest,
      task: state.plan.task, harness: state.plan.harness, runtimeDigest: state.plan.runtimeDigest,
      solution: checkpoint.solutions.find(s => s.digest === sourceDigest), selectionsDigest: digest(receipt.selections),
      allowance: { cpuSeconds: Math.min(perRefit.cpuSeconds, cpu), wallSeconds: Math.min(perRefit.wallSeconds, wall), tokens: 0, requests: 0, tools: 0 } })
    assert(request.solution.digest === sourceDigest, 'pending audit source differs')
    if (!audit.pending) { audit.attempts++; audit.pending = { request, startedAt: Date.now() }; await store.save('audits', id, audit) }
    try {
      const expiresAt = Math.min(audit.startedAt + limits.wallSeconds * 1000, (audit.pending.startedAt ?? audit.startedAt) + request.allowance.wallSeconds * 1000)
      const delivered = await withinDeadline(backend, request, expiresAt, signal => backend.deliver(request, { signal }), { signal })
      audit.cost = addCost(audit.cost, delivered.cost)
      audit.solutions[sourceDigest] = { status: delivered.status, quality: delivered.quality, accuracy: delivered.accuracy, receipt: delivered }
    } catch (error) {
      if (signal?.aborted) throw error
      audit.cost = addCost(audit.cost, { ...zeroCost(), cpuSeconds: request.allowance.cpuSeconds })
      audit.solutions[sourceDigest] = { status: 'unavailable', reason: String(error.message).slice(0, 1000), requestDigest: request.digest }
    }
    audit.pending = null; await store.save('audits', id, audit)
  }
  const result = seal({ protocol: 'analysis-audit@1', sequenceReceiptDigest: receipt.digest, selectionDigest: digest(receipt.selections),
    solutions: audit.solutions, cost: audit.cost, wallSeconds: Math.min(limits.wallSeconds, (Date.now() - audit.startedAt) / 1000) })
  await store.save('audits', id, { ...audit, status: 'complete', result })
  await controller.settleAuxiliary('audit', id, result)
  return result
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, sequence: { type: 'string' }, audit: { type: 'boolean' } } })
  assert(v.project && v.sequence, '--project and --sequence required')
  const directory = resolve(v.project), project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const state = await store.load('sequences', v.sequence.replace(/^sha256:/, '')); assert(state?.receipt, 'sequence is not complete')
  const audit = v.audit ? await withOperatorCancellation(signal => auditSequence(store, new HitchBackend(store, project.backend), project, state.receipt, { signal }))
    : (await store.load('audits', state.plan.digest.slice(7)))?.result
  const start = await store.get(state.startCheckpointRef)
  console.log(JSON.stringify({ report: trajectoryReport(state.receipt, start, state.steps.map(s => s.experiment), audit), modelAccounting: project.modelAccounting }, null, 2))
}
if (isMain(import.meta.url)) cli(main)
