import { assert, digest } from './contracts.mjs'
import { internalScore, internalQuality } from './metrics.mjs'
import { experimentValidationDigest } from './validation.mjs'

// A view never changes an old receipt or guesses an absent variant/configuration.
export function recordView(e) {
  const a = e.analysis
  return {
    identity: { experimentId: e.experimentId, runId: e.rolloutRunId, protocol: e.protocol, receiptDigest: e.digest,
      parentExperimentId: e.parentExperimentId, harness: a?.harness ?? null, workflowVersion: a?.workflow?.configDigest ?? null,
      toolVersion: a?.toolVersion ?? null, timestamp: a?.timestamp ?? null },
    scope: { dataset: a?.dataset ?? null, validation: experimentValidationDigest(e), metric: e.execution.metric ?? 'accuracy',
      checkpoint: a?.checkpoint ?? null, visibility: a?.visibility ?? null },
    intent: { ...e.claim, stages: a?.stages ?? [] }, plan: a?.plan ?? null,
    execution: { ...e.execution, trials: a?.trials ?? null, fits: a?.fits ?? null },
    variants: a?.variants ?? null,
    formal_evaluation: { kind: e.protocol === 'analysis-experiment@5' ? 'round_five_fold_cv' : 'legacy_validation',
      variantId: a?.formalVariantId ?? null, score: internalScore(e), utility: internalQuality(e),
      ...(e.protocol === 'analysis-experiment@5' ? { stdScore: e.execution.stdScore, validation: a.validation } : {}), receiptDigest: e.execution.receiptDigest },
    decision: a?.decision ?? null, notes: { ...e.interpretation, entries: a?.notes ?? [] },
    workflow: a?.workflow ?? null,
    artifacts_and_trace: { artifacts: a?.artifacts ?? [], sourceDigest: e.sourceDigest,
      predictionsDigest: e.execution.predictionsDigest ?? e.execution.oofDigest ?? null,
      trace: [{ runId: e.rolloutRunId, canonicalDigest: null, seq: null, field: null,
        retrieval: 'public trajectoryPage/trajectory.query resolves canonical digest and tool-event sequence' }, ...(a?.trace ?? [])] },
  }
}
export function filterRecords(records, { filters = {}, scope = 'all_authorized' } = {}, compatible = {}) {
  assert(['all_authorized', 'compatible_checkpoint'].includes(scope), 'unsupported history scope')
  assert(Object.keys(filters).every(k => ['dataset', 'validation', 'stages', 'model', 'status', 'keywords'].includes(k)), 'unknown record filter')
  return records.filter(r => {
    if (scope === 'compatible_checkpoint' && (r.scope.validation !== compatible.validation || r.scope.metric !== compatible.metric)) return false
    for (const key of ['dataset', 'validation']) if (filters[key] && filters[key] !== r.scope[key]) return false
    if (filters.status && !filters.status.includes(r.execution.status)) return false
    if (filters.stages && !filters.stages.some(s => r.intent.stages.includes(s))) return false
    if (filters.model && !r.variants?.some(v => JSON.stringify(v.config.model).includes(filters.model))) return false
    return !filters.keywords || JSON.stringify(r).toLowerCase().includes(filters.keywords.toLowerCase())
  })
}
export function pageRecords(records, query = {}) {
  const size = query.limit ?? 5
  assert(Number.isInteger(size) && size > 0 && size <= 20, 'page limit must be 1..20')
  const { cursor: _cursor, ...binding } = query
  const signature = digest({ binding, identities: records.map(r => [r.identity.experimentId, r.identity.receiptDigest]) })
  let offset = 0
  if (query.cursor) {
    const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
    assert(cursor.signature === signature && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= records.length, 'stale or foreign history cursor')
    offset = cursor.offset
  }
  const end = Math.min(offset + size, records.length)
  return { total: records.length, offset, records: records.slice(offset, end),
    nextCursor: end < records.length ? Buffer.from(JSON.stringify({ signature, offset: end })).toString('base64url') : null,
    coverage: { returned: end - offset, total: records.length, scope: query.scope ?? 'all_authorized', filters: query.filters ?? {} } }
}
export function compareRecords(records) {
  assert(records.length >= 2 && records.length <= 20, 'compare requires 2..20 records')
  const known = records.every(r => r.scope.dataset && r.formal_evaluation.score !== null)
  const comparable = known && new Set(records.map(r => digest(r.scope))).size === 1
  // Checkpoints/visibility can differ after sequential research; data and validation cannot.
  const sameEvaluation = known && new Set(records.map(r => digest({ dataset: r.scope.dataset, validation: r.scope.validation, metric: r.scope.metric }))).size === 1
  return { comparable: comparable || sameEvaluation, reason: sameEvaluation ? null : 'different evaluation scopes or unknown data/score; no ranking',
    rows: records.map(r => ({ id: r.identity.experimentId, variantId: r.formal_evaluation.variantId,
      ...r.scope, score: r.formal_evaluation.score, cost: r.execution.cost, decision: r.decision })) }
}
