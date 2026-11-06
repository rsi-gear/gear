// The identical generated JSON Schema is shipped with the Hitch producer.
const str = { type: 'string' }, num = { type: 'number', minimum: 0 }, sha = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const ref = name => ({ $ref: `#/$defs/${name}` })
const arr = items => ({ type: 'array', items })
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] })
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const sealed = (protocol, properties) => object({ protocol: { const: protocol }, ...properties, digest: sha })
export const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:gear:analysis-protocol:1', $defs: {
    Cost: object(Object.fromEntries(['cpuSeconds', 'tokens', 'requests', 'tools'].map(k => [k, num]))),
    Prediction: object({ idColumn: str, targetColumn: str, kind: { const: 'binary-label' }, allowedLabels: { ...arr(str), minItems: 2, maxItems: 2, uniqueItems: true } }),
    Task: sealed('analysis-task@1', { taskId: str, taskFamilyId: str, description: str,
      inputs: object({ trainDigest: sha, predictDigest: sha }), prediction: ref('Prediction'), predictIds: { ...arr(str), uniqueItems: true }, validationPlanDigest: sha, runtimeDigest: sha }),
    Fold: object({ fold: { type: 'integer', minimum: 0, maximum: 4 }, rows: { type: 'integer', minimum: 1 }, correct: { type: 'integer', minimum: 0 }, accuracy: { ...num, maximum: 1 } }),
    Solution: sealed('analysis-solution@1', { files: { ...arr(object({ path: str, digest: sha, bytes: { type: 'integer', minimum: 0, maximum: 16777216 } })), minItems: 1, maxItems: 64 },
      entrypoint: str, parameters: object({}), trainingSeed: { type: 'integer' }, runtimeDigest: sha, authoredByRunId: str }),
    Experiment: sealed('analysis-experiment@1', { experimentId: str, sequenceId: str, rolloutRunId: str, slotIndex: { type: 'integer', minimum: 1, maximum: 5 },
      parentExperimentId: nullable(str), operator: { enum: ['draft', 'debug', 'improve', 'confirm', 'reuse'] }, sourceDigest: nullable(sha), validationPlanDigest: sha, trainingSeed: { type: 'integer' },
      claim: object({ hypothesis: str, intendedChange: str }),
      execution: object({ status: { enum: ['completed', 'reused', 'generation_failed', 'candidate_failed'] }, receiptDigest: sha, physicalAttemptRefs: arr(str), reusedEvidenceRefs: arr(sha), cost: ref('Cost'),
        foldMetrics: arr(ref('Fold')), pooledAccuracy: nullable({ ...num, maximum: 1 }), oofDigest: nullable(sha) }),
      interpretation: object({ conclusion: str, limitations: arr(str) }) }),
    Checkpoint: sealed('analysis-research-checkpoint@1', { researchProjectId: str, taskFamilyId: str, baseTaskDigest: sha, dataScopeDigest: sha,
      validationPlanDigest: nullable(sha), runtimeDigest: sha, scorerDigest: sha, parentCheckpointDigests: arr(sha), sourceOutputManifests: arr(sha), history: arr(ref('Experiment')),
      solutions: arr(ref('Solution')), historyVisibilityDigest: sha, cachePolicyDigest: sha, costEvents: arr(object({ id: str, cost: ref('Cost') })), currentSolutionDigest: nullable(sha), mergePolicyDigest: sha }),
    RolloutOutput: sealed('analysis-rollout-output@1', { requestDigest: sha, runId: str, experiment: ref('Experiment'), solutions: arr(ref('Solution')),
      selectedSolutionDigest: nullable(sha), availableEvidenceRefs: arr(sha), selectionPolicyDigest: sha, sealedAt: str, cost: ref('Cost'), stop: { type: 'boolean' } }),
  },
}

// V1 remains readable with its original accuracy semantics. MLE-bench uses
// explicit raw scores and a monotone utility, never a renamed "accuracy".
schema.$defs.PredictionV1 = schema.$defs.Prediction
schema.$defs.PredictionV2 = object({ kind: { const: 'tabular' }, idColumn: str,
  targetColumns: { ...arr(str), minItems: 1, uniqueItems: true },
  metric: { enum: ['accuracy', 'auc-roc', 'mean-column-wise-rmsle'] }, labels: { ...arr(str), uniqueItems: true } })
schema.$defs.Prediction = { anyOf: [ref('PredictionV1'), ref('PredictionV2')] }
schema.$defs.TaskV1 = { ...schema.$defs.Task, properties: { ...schema.$defs.Task.properties, prediction: ref('PredictionV1') } }
schema.$defs.TaskV2 = sealed('analysis-task@2', { ...Object.fromEntries(Object.entries(schema.$defs.Task.properties).filter(([k]) => !['protocol', 'digest', 'prediction'].includes(k))),
  prediction: ref('PredictionV2'), publicFiles: arr(object({ path: str, digest: sha, bytes: { type: 'integer', minimum: 0 },
    role: { enum: ['shared', 'train', 'predict'] }, rowId: nullable(str) })),
  benchmark: object({ format: { const: 'mle-bench' }, competitionId: str, definitionDigest: sha, publicTreeDigest: sha,
    sourceRevision: str, verification: { enum: ['upstream-checksums', 'custom-checksums', 'fixture'] } }) })
schema.$defs.Task = { anyOf: [ref('TaskV1'), ref('TaskV2')] }
schema.$defs.ExperimentV1 = schema.$defs.Experiment
schema.$defs.FoldV2 = object({ fold: { type: 'integer', minimum: 0, maximum: 4 }, rows: { type: 'integer', minimum: 1 }, score: num, utility: { ...num, maximum: 1 } })
schema.$defs.ExperimentV2 = sealed('analysis-experiment@2', {
  ...Object.fromEntries(Object.entries(schema.$defs.Experiment.properties).filter(([k]) => !['protocol', 'digest', 'execution'].includes(k))),
  execution: object({ ...Object.fromEntries(Object.entries(schema.$defs.Experiment.properties.execution.properties).filter(([k]) => !['foldMetrics', 'pooledAccuracy'].includes(k))),
    metric: { enum: ['accuracy', 'auc-roc', 'mean-column-wise-rmsle'] }, foldMetrics: arr(ref('FoldV2')), pooledScore: nullable(num), pooledUtility: nullable({ ...num, maximum: 1 }) }) })
schema.$defs.Experiment = { anyOf: [ref('ExperimentV1'), ref('ExperimentV2')] }

Object.assign(schema.$defs, {
  Harness: object({ commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, manifestDigest: sha }),
  Allowance: object({ wallSeconds: num, cpuSeconds: num, tools: num, tokens: nullable(num), requests: nullable(num) }),
  Budget: object({ wallSeconds: num, reserveSeconds: num, cpuSeconds: num, reserveCpuSeconds: num, tokens: nullable(num), requests: nullable(num),
    tools: num, reserveTools: num, experimentWallSeconds: num, experimentCpuSeconds: num, maxFileBytes: num, maxOutputBytes: num }),
  SequencePlan: sealed('analysis-five-rollout@1', { task: ref('Task'), startingCheckpointDigest: sha, harness: ref('Harness'), model: str,
    budget: ref('Budget'), runtimeDigest: sha, experiments: { const: 5 }, repetitions: { const: 1 } }),
  RolloutRequest: sealed('analysis-rollout-request@1', { sequenceId: str, slotIndex: { type: 'integer', minimum: 1, maximum: 5 }, planDigest: sha,
    task: ref('Task'), harness: ref('Harness'), model: str, runtimeDigest: sha, checkpointDigest: sha, checkpointRef: sha,
    previousRolloutReceiptDigest: nullable(sha), eligibleSolutionDigests: { ...arr(sha), uniqueItems: true }, allowance: ref('Allowance'),
    experimentWallSeconds: num, experimentCpuSeconds: num }),
  Selection: sealed('analysis-slot-selection@1', { slotIndex: { type: 'integer', minimum: 1, maximum: 5 }, experimentId: nullable(str),
    status: { enum: ['attempted', 'not_started'] }, stopReason: nullable(str), incumbentSolutionDigest: nullable(sha), carryForward: { type: 'boolean' },
    availableEvidenceRefs: arr(sha), selectionPolicyDigest: nullable(sha), cumulativeCostDigest: sha, sealedAt: str, rolloutReceiptDigest: nullable(sha) }),
  SourceSelectionPlan: sealed('analysis-source-selection@1', { sequencePlanDigest: sha, sourceSequenceReceiptDigest: sha, startingCheckpointDigest: sha,
    harness: ref('Harness'), runtimeDigest: sha, budgetDigest: sha, childRuns: arr(object({ runId: str, receiptDigest: sha, outputManifestDigest: sha })),
    sourceRunId: str, outputManifestDigest: sha, solutionDigest: sha }),
  RefitRequest: sealed('analysis-refit-request@1', { task: ref('Task'), solution: ref('Solution'), runtimeDigest: sha, harness: ref('Harness'),
    sourceSelectionPlan: ref('SourceSelectionPlan'), allowance: ref('Allowance') }),
})
for (const [name, protocol] of [['DeliveryRequest', 'analysis-delivery-request@1'], ['AuditRequest', 'analysis-audit-request@1']])
  schema.$defs[name] = sealed(protocol, { sequenceId: str, planDigest: sha, task: ref('Task'), harness: ref('Harness'), runtimeDigest: sha,
    solution: ref('Solution'), selectionsDigest: sha, allowance: ref('Allowance') })

export function validateRequest(value) {
  const name = { 'analysis-rollout-request@1': 'RolloutRequest', 'analysis-delivery-request@1': 'DeliveryRequest',
    'analysis-audit-request@1': 'AuditRequest', 'analysis-refit-request@1': 'RefitRequest' }[value?.protocol]
  if (!name) throw new Error('unsupported analysis request protocol')
  return validateSchema(name, value)
}

export function validateSchema(name, value) {
  const check = (s, v, path) => {
    if (s.$ref) return check(schema.$defs[s.$ref.split('/').at(-1)], v, path)
    if (s.anyOf) {
      const errors = []
      for (const variant of s.anyOf) { try { check(variant, v, path); return } catch (error) { errors.push(error.message) } }
      throw new Error(`${path}: invalid union (${errors.join('; ')})`)
    }
    if ('const' in s && v !== s.const || s.enum && !s.enum.includes(v)) throw new Error(`${path}: unsupported value`)
    if (!s.type) return
    if (s.type === 'null') { if (v !== null) throw new Error(`${path}: expected null`); return }
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || s.required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !Object.hasOwn(s.properties, k))) throw new Error(`${path}: unexpected/missing fields`)
      for (const [k, field] of Object.entries(s.properties)) check(field, v[k], `${path}.${k}`)
    } else if (s.type === 'array') {
      if (!Array.isArray(v) || v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || s.uniqueItems && new Set(v).size !== v.length) throw new Error(`${path}: invalid array`)
      v.forEach((x, i) => check(s.items, x, `${path}[${i}]`))
    } else if (s.type === 'number' || s.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v) || s.type === 'integer' && !Number.isSafeInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) throw new Error(`${path}: invalid number`)
    } else if (typeof v !== s.type || s.pattern && !new RegExp(s.pattern).test(v)) throw new Error(`${path}: invalid ${s.type}`)
  }
  if (!schema.$defs[name]) throw new Error('unknown protocol schema')
  check(schema.$defs[name], value, name); return value
}
