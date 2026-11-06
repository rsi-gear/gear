// Offline package-test adapter. It validates templates and durable orchestration,
// not target-model behavior or a real provider's accounting.
import { createHash } from 'node:crypto'
import { readFile, mkdir, cp, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const input = JSON.parse(await new Promise(resolve => { let value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => resolve(value)) }))
const { action, request, configuration, context } = input
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const identity = hash(await readFile(new URL(import.meta.url)))
let result
if (action === 'describe') result = { version: 1, identity, capabilities: { seeds: false, temperature: false, subsets: true, idempotentSubmission: true, inspect: true, cancel: true, physicalAttemptAccounting: true, evidenceProjection: configuration.projectEvidence === true, generationBudget: !!context && typeof context === 'object' && !('benchmark' in context), hardDollarBudget: false } }
else {
  const receiptPath = join(configuration.receipts, request.operationId.slice(7) + '.json')
  if (action === 'inspect') {
    try { result = { state: 'complete', receipt: JSON.parse(await readFile(receiptPath, 'utf8')) } }
    catch (error) { if (error.code !== 'ENOENT') throw error; result = { state: 'not_submitted' } }
  } else if (action === 'cancel') result = { cancelled: true }
  else if (action === 'project_evidence') {
    if (!configuration.projectEvidence || !request.projection || request.repair) throw new Error('Invalid projection request')
    const original = JSON.parse(await readFile(join(configuration.receipts, request.projection.rootOperationId.slice(7) + '.json'), 'utf8'))
    const evidence = structuredClone(request.evidence)
    for (const cell of evidence) {
      const source = original.provenance.observations.find(value => value.task_id === cell.task_id && value.repetition === cell.repetition)
      if (!source || original.result.candidate_id !== cell.candidate_id) throw new Error('Projection source changed')
      const missing = request.projection.missing.find(value => value.taskId === cell.task_id && value.repetition === cell.repetition)
      for (const id of missing.assertions ?? []) {
        const contract = request.assertions.find(value => value.id === id)
        if (contract.source.path !== 'originalResult.fixture_assertion') throw new Error('Unsupported fixture assertion')
        cell.assertions = [...(cell.assertions ?? []).filter(value => value.id !== id), {
          id, schemaDigest: contract.digest, status: source.fixture_assertion, evidenceRefs: [hash(JSON.stringify(source))],
        }]
      }
      for (const id of missing.metrics) {
        const metric = request.metrics.find(value => value.id === id)
        if (metric.source.path !== 'originalResult.fixture_quality') throw new Error('Unsupported fixture metric')
        cell.raw_metrics = { ...cell.raw_metrics, [id]: { status: 'available', value: source.fixture_quality,
          contractDigest: metric.digest, unit: metric.unit, evidenceRefs: [hash(JSON.stringify(source))] } }
      }
    }
    result = { result: { operation_id: request.operationId, kind: request.operation.kind, status: 'complete', candidate_id: request.operation.candidate_id, data: null },
      candidate: null, evidence, physicalAttempts: 0, usage: { model_requests: 0, tokens: 0 }, provenance: { original: request.projection.rootOperationId } }
    await writeFile(receiptPath, JSON.stringify(result), { flag: 'wx' })
  }
  else {
    if (action !== 'submit' || request.projection) throw new Error('Projection must not execute a target')
    await mkdir(configuration.receipts, { recursive: true })
    const { operation } = request
    if (operation.kind !== 'evaluate_seed') {
      if ('benchmark' in context || context.tasks.some(task => task.id.startsWith('word-'))) throw new Error('Meta context leaked private benchmark')
      if (!request.evidence.length) throw new Error('Meta operation lost its authorized seed evidence')
    }
    const candidate = operation.kind === 'generate_candidate' ? { id: operation.candidate_id, parent_id: operation.parent_id, digest: hash(operation.candidate_id) } : null
    if (candidate) {
      const target = join(context.targets, candidate.id)
      await cp(join(context.targets, candidate.parent_id), target, { recursive: true })
      const rule = context.targetAdapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'
      await chmod(join(target, rule), 0o600)
      await writeFile(join(target, rule), 'offline candidate rule\n', { mode: 0o400 })
      await chmod(join(target, rule), 0o400)
    }
    const rule = context.targetAdapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'
    const improved = operation.kind === 'evaluate_seed' && (await readFile(join(context.targets, operation.candidate_id, rule), 'utf8')).includes('offline candidate rule')
    const evidence = request.slots.map(slot => {
      const verifier = context.benchmark.verifiers[slot.taskId]
      const actual = improved ? verifier.expected : 'incorrect'
      const scoring = spawnSync(configuration.python, ['-m', 'gear', 'benchmark', 'score'], {
        input: JSON.stringify({ actual, expected: verifier.expected, rule: verifier.rule }), encoding: 'utf8',
      })
      if (scoring.status !== 0) throw new Error(scoring.stderr)
      const value = JSON.parse(scoring.stdout)
      return { candidate_id: operation.candidate_id, task_id: slot.taskId, repetition: slot.repetition, score: value.value,
        status: value.status, scope: operation.scope, feedback: value.reason }
    })
    if (configuration.failInitialEvaluation && operation.kind === 'evaluate_seed' && !request.repair && evidence.length) {
      evidence[0] = { ...evidence[0], score: null, status: 'environment_failed', feedback: 'Injected package-test infrastructure failure' }
    }
    result = { result: { operation_id: request.operationId, kind: operation.kind, status: 'complete', candidate_id: operation.candidate_id,
      data: operation.kind === 'diagnose_seed' ? { hypotheses: ['Improve the fixture.'] } : null }, candidate, evidence,
      physicalAttempts: request.slots.length, usage: { model_requests: 0, tokens: 0 }, provenance: { test_fixture: true, identity,
        observations: evidence.map(cell => ({ task_id: cell.task_id, repetition: cell.repetition, fixture_quality: cell.score, fixture_assertion: 'failed' })) } }
    await writeFile(receiptPath, JSON.stringify(result), { flag: 'wx' })
  }
}
process.stdout.write(JSON.stringify(result))
