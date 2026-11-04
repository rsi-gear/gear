// Deterministic external executor for the opt-in cross-version recovery test.
// Its process profile and actual source digest pass through production admission.
import { createHash } from 'node:crypto'
import { appendFile, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const input = JSON.parse(await new Promise((resolveInput) => {
  let text = ''
  process.stdin.on('data', (chunk) => { text += chunk })
  process.stdin.on('end', () => resolveInput(text))
}))
const { action, request, context } = input
const identity = 'sha256:' + createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
const meta = !Object.hasOwn(context, 'benchmark')
let result
if (action === 'describe') {
  result = { version: 1, identity, capabilities: {
    seeds: true, temperature: true, subsets: true,
    idempotentSubmission: true, inspect: true, cancel: true,
    physicalAttemptAccounting: true, evidenceProjection: false,
    generationBudget: meta, hardDollarBudget: false,
  } }
} else {
  const directory = resolve(context.targets, '../external-fixture')
  await mkdir(directory, { recursive: true })
  const receiptPath = join(directory, request.operationId.slice(7) + '.json')
  const { operation } = request
  await appendFile(join(directory, 'calls.jsonl'), JSON.stringify({
    action, operationId: request.operationId, kind: operation.kind,
    candidateId: operation.candidate_id, partition: request.partition, slots: request.slots,
  }) + '\n')
  if (action === 'inspect') {
    try { result = { state: 'complete', receipt: JSON.parse(await readFile(receiptPath, 'utf8')) } }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      result = { state: 'not_submitted' }
    }
  } else if (action === 'cancel') {
    result = { cancelled: true }
  } else {
    if (action !== 'submit') throw new Error('Unexpected executor action: ' + action)
    // Repeating an accepted submission is deliberately observable, even when
    // another provider might deduplicate it itself.
    try {
      await readFile(receiptPath)
      throw new Error('Duplicate external work: ' + request.operationId)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (meta && (context.tasks.some((task) => task.id.startsWith('private-')) || !request.evidence.length))
      throw new Error('Meta seed context is missing or contains held-out tasks')
    if (meta && (request.generationLimits?.model_requests !== 1 || request.generationLimits?.tokens !== 32))
      throw new Error('Frozen generation limits changed')
    let candidate = null
    if (operation.kind === 'generate_candidate') {
      const target = join(context.targets, operation.candidate_id)
      await cp(join(context.targets, operation.parent_id), target, { recursive: true })
      await chmod(join(target, 'AGENTS.md'), 0o600)
      await writeFile(join(target, 'AGENTS.md'), 'Historical recovery candidate ' + operation.candidate_id + '\n')
      candidate = { id: operation.candidate_id, parent_id: operation.parent_id, digest: identity }
    }
    const evidence = request.slots.map((slot) => {
      const taskIndex = Number(slot.taskId.replace('seed-', ''))
      const solved = operation.candidate_id !== 'anchor' && (request.partition === 'held_out' ||
        (operation.candidate_id.startsWith('r1-') ? taskIndex % 4 !== 3 : taskIndex % 2 === 0))
      return {
        candidate_id: operation.candidate_id, task_id: slot.taskId, repetition: slot.repetition,
        score: solved ? 1 : 0, status: 'valid', scope: operation.scope, feedback: 'deterministic external observation',
      }
    })
    result = {
      result: { operation_id: request.operationId, kind: operation.kind,
        candidate_id: operation.candidate_id, status: 'complete',
        data: operation.kind === 'diagnose_seed' ? { hypotheses: ['Preserve the requested format.'] } : null },
      candidate, evidence, physicalAttempts: evidence.length,
      usage: { model_requests: meta ? 1 : 0, tokens: meta ? 8 : 0 },
      provenance: { identity, fixture: 'historical-search-provider-v1' },
    }
    await writeFile(receiptPath, JSON.stringify(result), { flag: 'wx' })
    const marker = resolve(context.targets, '../../../../interrupt.json')
    const interruption = await readFile(marker, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (interruption?.kind === operation.kind && operation.candidate_id.startsWith(interruption.candidatePrefix))
      throw new Error('Historical submission reply lost after durable external completion')
  }
}
process.stdout.write(JSON.stringify(result))
