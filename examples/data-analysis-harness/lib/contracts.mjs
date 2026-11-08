import { createHash } from 'node:crypto'
import { validateSchema } from './schemas.mjs'
import { utility } from './metrics.mjs'

export const PROTOCOL = 'analysis-five-rollout@1'
export const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-canonical JSON value')
  return JSON.stringify(value)
}
export const digest = value => sha(canonical(value))
export function assert(ok, message) { if (!ok) throw new Error(message) }
export const clone = value => structuredClone(value)
export function seal(body) { assert(!('digest' in body), 'already sealed'); return { ...clone(body), digest: digest(body) } }
export function verify(value) {
  assert(value && typeof value === 'object', 'missing sealed object')
  const { digest: expected, ...body } = value
  assert(/^sha256:[a-f0-9]{64}$/.test(expected) && digest(body) === expected, 'object digest mismatch')
  return value
}
export function keys(value, required, optional = []) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'expected object')
  assert(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), `unexpected/missing fields: ${Object.keys(value)}`)
}
export function finite(value, name, max = Infinity) { assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, `invalid ${name}`); return value }
export function sourcePath(path) { assert(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe source path'); return path }
export const dimensions = ['cpuSeconds', 'tokens', 'requests', 'tools']
export const zeroCost = () => Object.fromEntries(dimensions.map(k => [k, 0]))
export function cost(value) { keys(value, dimensions); for (const k of dimensions) finite(value[k], k); return value }
export const addCost = (a, b) => Object.fromEntries(dimensions.map(k => [k, a[k] + b[k]]))
export const defaultBudget = Object.freeze({ wallSeconds: 1800, reserveSeconds: 300, cpuSeconds: 2400,
  reserveCpuSeconds: 600, tokens: null, requests: null, tools: 150, reserveTools: 10,
  experimentWallSeconds: 240, experimentCpuSeconds: 300, maxFileBytes: 16 * 1024 ** 2, maxOutputBytes: 64 * 1024 ** 2 })
export function validateBudget(b) {
  keys(b, Object.keys(defaultBudget))
  for (const [k, v] of Object.entries(b)) if (!(v === null && ['tokens', 'requests'].includes(k))) finite(v, k)
  assert((b.tokens === null) === (b.requests === null), 'model accounting must be explicitly unbounded or bounded together')
  assert(b.wallSeconds > b.reserveSeconds && b.cpuSeconds >= b.reserveCpuSeconds && b.tools >= b.reserveTools, 'invalid finalization reserve')
  return b
}

// Explicit projection is the boundary: verifier/audit fields are never copied into research history.
export function validateExperiment(e) {
  validateSchema('Experiment', e)
  keys(e, ['protocol', 'experimentId', 'sequenceId', 'rolloutRunId', 'slotIndex', 'parentExperimentId', 'operator',
    'sourceDigest', 'validationPlanDigest', 'trainingSeed', 'claim', 'execution', 'interpretation', 'digest'], ['analysis-experiment@4', 'analysis-experiment@5'].includes(e.protocol) ? ['analysis'] : [])
  const holdout = ['analysis-experiment@3', 'analysis-experiment@4'].includes(e.protocol)
  const roundCv = e.protocol === 'analysis-experiment@5'
  verify(e); assert(['analysis-experiment@1', 'analysis-experiment@2', 'analysis-experiment@3', 'analysis-experiment@4', 'analysis-experiment@5'].includes(e.protocol), 'invalid experiment protocol')
  assert(Number.isSafeInteger(e.slotIndex) && e.slotIndex >= 1 && (holdout || roundCv || e.slotIndex <= 5), 'invalid slot')
  assert(['draft', 'debug', 'improve', 'confirm', 'reuse'].includes(e.operator), 'invalid operator')
  keys(e.claim, ['hypothesis', 'intendedChange']); keys(e.interpretation, ['conclusion', 'limitations'])
  const generic = e.protocol !== 'analysis-experiment@1'
  keys(e.execution, ['status', 'receiptDigest', 'physicalAttemptRefs', 'reusedEvidenceRefs', 'cost',
    ...(holdout ? ['metric', 'validationScore', 'validationUtility', 'validationRows', 'predictionsDigest']
      : ['foldMetrics', 'oofDigest', ...(generic ? ['metric', 'pooledScore', 'pooledUtility'] : ['pooledAccuracy']),
        ...(roundCv ? ['meanScore', 'meanUtility', 'stdScore'] : [])])])
  assert(['completed', 'reused', 'generation_failed', 'candidate_failed'].includes(e.execution.status), 'unavailable experiment cannot advance history')
  cost(e.execution.cost)
  if (e.protocol === 'analysis-experiment@4' || roundCv) {
    const a = e.analysis
    assert(a && Array.isArray(a.variants) && Array.isArray(a.notes) && Array.isArray(a.artifacts)
      && a.workflow?.states && a.harness && a.checkpoint && a.dataset && a.toolVersion, 'incomplete workflow record')
    for (const count of ['trials', 'fits', 'fitCalls']) assert(a[count] === null || Number.isSafeInteger(a[count]) && a[count] >= 0, 'invalid experiment work count')
    if (e.execution.status === 'completed') assert(a.plan && a.variants.some(v => v.id === a.formalVariantId && v.status === 'completed'), 'formal result has no evaluated variant')
  }
  if (roundCv) {
    const v = e.analysis.validation, plan = v?.plan
    validateSchema('RoundValidation', plan)
    assert(v.digest === digest(plan) && plan.policyDigest === e.validationPlanDigest && plan.trainDigest === e.analysis.dataset, 'CV evidence scope changed')
    if (validCandidate(e)) {
      const f = e.execution.foldMetrics
      assert(e.execution.oofDigest && f.length === 5, 'CV requires five folds and OOF predictions')
      assert(Array.isArray(v.rowIds) && Array.isArray(v.foldAssignments) && v.rowIds.length === v.foldAssignments.length
        && new Set(v.rowIds).size === v.rowIds.length && v.foldAssignments.every(n => Number.isInteger(n) && n >= 0 && n < 5), 'invalid CV row assignments')
      assert(f.every((row, i) => row.rows === v.foldAssignments.filter(n => n === i).length && row.rows > 0), 'CV rows do not match frozen folds')
      const mean = f.reduce((n, row) => n + row.score, 0) / 5
      const quality = f.reduce((n, row) => n + row.utility, 0) / 5
      const std = Math.sqrt(f.reduce((n, row) => n + (row.score - mean) ** 2, 0) / 5)
      assert(Math.abs(mean - e.execution.meanScore) < 1e-12 && Math.abs(quality - e.execution.meanUtility) < 1e-12
        && Math.abs(std - e.execution.stdScore) < 1e-12, 'CV aggregate differs from fold evidence')
    } else assert(e.execution.meanScore === null && e.execution.meanUtility === null && e.execution.stdScore === null && e.execution.oofDigest === null, 'failed CV has no selected score')
  }
  if (holdout) {
    if (['completed', 'reused'].includes(e.execution.status)) {
      assert(e.sourceDigest && e.execution.predictionsDigest && e.execution.validationRows > 0, 'successful experiment requires held-out predictions')
      assert(Math.abs(utility(e.execution.metric, e.execution.validationScore) - e.execution.validationUtility) < 1e-12, 'validation utility mismatch')
    } else assert(e.execution.validationScore === null && e.execution.validationUtility === null && e.execution.predictionsDigest === null, 'failed experiment has no validation score')
    return e
  }
  if (generic) {
    if (['completed', 'reused'].includes(e.execution.status)) {
      assert(e.sourceDigest && e.execution.foldMetrics.length === 5, 'successful experiment requires source and five folds')
      assert(Math.abs(utility(e.execution.metric, e.execution.pooledScore) - e.execution.pooledUtility) < 1e-12, 'pooled utility mismatch')
      for (const [index, f] of e.execution.foldMetrics.entries()) {
        assert(f.fold === index && Math.abs(utility(e.execution.metric, f.score) - f.utility) < 1e-12, 'invalid fold score or utility')
      }
    } else assert(e.execution.pooledScore === null && e.execution.pooledUtility === null, 'failed experiment has no score')
    return e
  }
  if (['completed', 'reused'].includes(e.execution.status)) {
    assert(e.sourceDigest && e.validationPlanDigest, 'successful experiment requires source and validation')
    finite(e.execution.pooledAccuracy, 'pooled accuracy', 1)
    assert(e.execution.foldMetrics.length === 5, 'five folds required')
    let correct = 0, rows = 0
    for (const [index, f] of e.execution.foldMetrics.entries()) {
      keys(f, ['fold', 'rows', 'correct', 'accuracy'])
      assert(f.fold === index && Number.isInteger(f.rows) && f.rows > 0 && Number.isInteger(f.correct) && f.correct >= 0 && f.correct <= f.rows, 'invalid fold')
      assert(Math.abs(f.accuracy - f.correct / f.rows) < 1e-12, 'fold accuracy mismatch')
      rows += f.rows; correct += f.correct
    }
    assert(Math.abs(e.execution.pooledAccuracy - correct / rows) < 1e-12, 'pooled accuracy mismatch')
  } else assert(e.execution.pooledAccuracy === null, 'failed experiment has no accuracy')
  return e
}
export function validateSolution(s) {
  validateSchema('Solution', s)
  keys(s, ['protocol', 'files', 'entrypoint', 'parameters', 'trainingSeed', 'runtimeDigest', 'authoredByRunId', 'digest'])
  verify(s); assert(['analysis-solution@1', 'analysis-solution@2'].includes(s.protocol), 'invalid solution')
  if (s.protocol === 'analysis-solution@2') {
    const p = verify(s.parameters)
    assert(p.protocol === 'analysis-resolved-pipeline@1' && p.configDigest === digest(p.config) && p.codeDigest === digest(s.files)
      && p.runtimeDigest === s.runtimeDigest && p.entrypoint === s.entrypoint && p.trainingEntry === 'build_pipeline' && p.fitCount === 1 && p.actualParameters,
      'resolved pipeline differs from source/config/runtime')
  }
  assert(s.files.length > 0 && s.files.length <= 64, 'invalid source closure')
  const names = new Set()
  for (const f of s.files) { keys(f, ['path', 'digest', 'bytes']); sourcePath(f.path); assert(!names.has(f.path), 'duplicate source'); names.add(f.path); finite(f.bytes, 'source bytes', defaultBudget.maxFileBytes) }
  assert(names.has(s.entrypoint) && s.entrypoint.endsWith('.py'), 'missing Python entrypoint')
  return s
}
export function validCandidate(e) { return e && ['completed', 'reused'].includes(e.execution.status) }

export function validateCheckpoint(k) {
  validateSchema('Checkpoint', k)
  keys(k, ['protocol', 'researchProjectId', 'taskFamilyId', 'baseTaskDigest', 'dataScopeDigest', 'validationPlanDigest',
    'runtimeDigest', 'scorerDigest', 'parentCheckpointDigests', 'sourceOutputManifests', 'history', 'solutions',
    'historyVisibilityDigest', 'cachePolicyDigest', 'costEvents', 'currentSolutionDigest', 'mergePolicyDigest', 'digest'])
  verify(k); assert(k.protocol === 'analysis-research-checkpoint@1', 'invalid checkpoint')
  for (const e of k.history) validateExperiment(e)
  assert(new Set(k.history.map(e => e.experimentId)).size === k.history.length, 'duplicate experiment identity')
  for (const s of k.solutions) validateSolution(s)
  assert(new Set(k.solutions.map(s => s.digest)).size === k.solutions.length, 'duplicate solution')
  for (const e of k.history) if (e.sourceDigest) assert(k.solutions.some(s => s.digest === e.sourceDigest), 'missing source closure')
  if (k.currentSolutionDigest) assert(k.history.some(e => validCandidate(e) && e.sourceDigest === k.currentSolutionDigest && e.validationPlanDigest === k.validationPlanDigest), 'current solution lacks compatible evidence')
  for (const event of k.costEvents) { keys(event, ['id', 'cost']); cost(event.cost) }
  assert(new Set(k.costEvents.map(e => e.id)).size === k.costEvents.length, 'duplicate cost event')
  assert(k.costEvents.length === k.history.length && k.history.every(e => k.costEvents.some(c => c.id === e.rolloutRunId
    && digest(c.cost) === digest(e.execution.cost))), 'history cost events differ from original experiments')
  assert(k.historyVisibilityDigest === digest(k.history.map(e => e.digest)), 'history visibility mismatch')
  return k
}
export function initialCheckpoint({ researchProjectId, taskFamilyId, baseTaskDigest, dataScopeDigest, runtimeDigest, scorerDigest, validationPlanDigest = null }) {
  return seal({ protocol: 'analysis-research-checkpoint@1', researchProjectId, taskFamilyId, baseTaskDigest, dataScopeDigest,
    validationPlanDigest, runtimeDigest, scorerDigest, parentCheckpointDigests: [], sourceOutputManifests: [],
    history: [], solutions: [], historyVisibilityDigest: digest([]), cachePolicyDigest: digest('source-metrics-only@1'),
    costEvents: [], currentSolutionDigest: null, mergePolicyDigest: digest('all-compatible-facts@1') })
}
export function compatible(a, b) {
  for (const k of ['researchProjectId', 'taskFamilyId', 'baseTaskDigest', 'dataScopeDigest', 'runtimeDigest', 'scorerDigest', 'cachePolicyDigest', 'mergePolicyDigest']) assert(a[k] === b[k], `checkpoint scope mismatch: ${k}`)
  assert(!a.validationPlanDigest || a.validationPlanDigest === b.validationPlanDigest, 'validation plan changed')
}
function union(items, key) {
  const m = new Map()
  for (const item of items) { const id = key(item); assert(!m.has(id) || canonical(m.get(id)) === canonical(item), 'conflicting immutable history'); m.set(id, item) }
  return [...m.values()].sort((a, b) => key(a).localeCompare(key(b)))
}
export function advance(k, experiment, solutions, selected, manifest) {
  validateCheckpoint(k); validateExperiment(experiment)
  assert(!k.history.some(e => e.experimentId === experiment.experimentId), 'experiment already appended')
  assert(!k.validationPlanDigest || experiment.validationPlanDigest === k.validationPlanDigest, 'validation plan changed')
  const history = [...k.history, experiment]
  const { digest: _, ...body } = k
  return validateCheckpoint(seal({ ...body, validationPlanDigest: experiment.validationPlanDigest,
    parentCheckpointDigests: [k.digest], sourceOutputManifests: [...k.sourceOutputManifests, manifest], history,
    solutions: union([...k.solutions, ...solutions], s => s.digest), historyVisibilityDigest: digest(history.map(e => e.digest)),
    costEvents: [...k.costEvents, { id: experiment.rolloutRunId, cost: experiment.execution.cost }], currentSolutionDigest: selected }))
}
export function mergeCheckpoints(base, branches, adopted) {
  validateCheckpoint(base)
  for (const b of branches) { validateCheckpoint(b); compatible(base, b); assert(b.validationPlanDigest === branches[0].validationPlanDigest, 'cannot rank different validation plans') }
  assert(branches.some(b => b.digest === adopted.digest), 'adopted branch is outside merge plan')
  const { digest: _, ...body } = base
  const history = union([base, ...branches].flatMap(b => b.history), e => e.experimentId)
  return validateCheckpoint(seal({ ...body, validationPlanDigest: adopted.validationPlanDigest, parentCheckpointDigests: branches.map(b => b.digest).sort(),
    sourceOutputManifests: [...new Set([base, ...branches].flatMap(b => b.sourceOutputManifests))].sort(), history,
    solutions: union([base, ...branches].flatMap(b => b.solutions), s => s.digest), historyVisibilityDigest: digest(history.map(e => e.digest)),
    costEvents: union([base, ...branches].flatMap(b => b.costEvents), e => e.id), currentSolutionDigest: adopted.currentSolutionDigest ?? base.currentSolutionDigest }))
}
