import { assert, digest } from './contracts.mjs'

export const stageStatuses = ['not_started', 'running', 'completed', 'reused', 'skipped', 'failed']
export const stageUpdateInstructions = 'Call experiment with action="record" and a stage object. Use artifact digests returned by analysis_execute, experiment.run or experiment.get. Completed/reused stages require evidence; reused/skipped/failed require a reason. EDA completion requires observed analysis output, not code or notes alone. Reuse requires unchanged inputs, dependencies and evidence. Script execution and notes alone do not update stage state.'
export function stageUpdateParameter(config) {
  return { type: 'object', additionalProperties: false, description: stageUpdateInstructions,
    properties: {
      stage: { type: 'string', required: true, enum: config.stages.map(s => s.id), description: 'Workflow stage ID.' },
      status: { type: 'string', required: true, enum: stageStatuses },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Up to 100 visible artifact digests; required for completed/reused.' },
      conclusion: { type: 'string', description: 'Evidence-backed findings and their modeling implications, at most 4000 characters.' },
      reason: { type: 'string', description: 'Required for reused, skipped or failed; at most 4000 characters.' },
      inputs: { type: 'object', additionalProperties: true, description: 'Stage-specific input versions, at most 4000 JSON bytes. Scope and dependency versions are added by the runtime.' },
    } }
}
export function validateWorkflow(config) {
  assert(config.version === 2 && Array.isArray(config.stages) && config.stages.length > 0, 'invalid workflow')
  const seen = new Set()
  for (const s of config.stages) {
    assert(/^[a-z_]+$/.test(s.id) && !seen.has(s.id), 'duplicate or invalid stage')
    assert(/^prompts\/stages\/[a-z_-]+\.md$/.test(s.prompt), 'invalid stage prompt')
    assert(Array.isArray(s.dependsOn) && s.dependsOn.every(id => seen.has(id)), 'stage dependencies must precede it')
    seen.add(s.id)
  }
  return config
}
export function restoreWorkflow(config, history, scope) {
  validateWorkflow(config)
  const states = Object.fromEntries(config.stages.map(s => [s.id, { status: 'not_started', inputs: {}, artifacts: [], conclusion: '', reason: null }]))
  // Merged history is sorted by immutable experiment ID, not chronology. Keep
  // one coherent compatible snapshot; never splice dependent stages from peers.
  const chronological = history.map((e, index) => ({ e, index })).sort((a, b) =>
    (Date.parse(a.e.analysis?.timestamp) || 0) - (Date.parse(b.e.analysis?.timestamp) || 0)
    || (a.e.sequenceId ?? '').localeCompare(b.e.sequenceId ?? '') || (a.e.slotIndex ?? 0) - (b.e.slotIndex ?? 0)
    || (a.e.experimentId ?? '').localeCompare(b.e.experimentId ?? '') || a.index - b.index)
  for (const { e } of chronological) {
    const previous = e.analysis?.workflow
    if (!previous || previous.scope !== scope || previous.configDigest !== digest(config)) continue
    for (const [id, state] of Object.entries(previous.states)) if (states[id]) states[id] = structuredClone(state)
  }
  return { configDigest: digest(config), scope, states }
}
export function updateStage(config, workflow, update, authorizedArtifacts) {
  assert(update && typeof update === 'object' && !Array.isArray(update)
    && Object.keys(update).every(k => ['stage', 'status', 'artifacts', 'conclusion', 'reason', 'inputs'].includes(k)), 'invalid stage update fields')
  const { stage, status, artifacts = [], conclusion = '', reason = null, inputs = {} } = update
  assert(Object.hasOwn(workflow.states, stage) && stageStatuses.includes(status), 'invalid stage update')
  assert(typeof conclusion === 'string' && conclusion.length <= 4000, 'stage conclusion too large')
  assert(Array.isArray(artifacts) && artifacts.every(ref => typeof ref === 'string') && artifacts.length <= 100
    && inputs && typeof inputs === 'object' && !Array.isArray(inputs) && Buffer.byteLength(JSON.stringify(inputs)) <= 4000, 'invalid stage inputs/artifacts or limit exceeded')
  assert(artifacts.every(ref => authorizedArtifacts.has(ref)), 'stage artifact outside visible evidence')
  if (['reused', 'skipped', 'failed'].includes(status)) assert(typeof reason === 'string' && reason.trim() && reason.length <= 4000, 'stage reason required')
  if (['completed', 'reused'].includes(status)) assert(artifacts.length > 0, 'completed stage requires evidence')
  const spec = config.stages.find(s => s.id === stage)
  const versions = { ...inputs, scope: workflow.scope, dependencies: Object.fromEntries(spec.dependsOn.map(id => [id, digest(workflow.states[id])])) }
  const prior = workflow.states[stage]
  if (status === 'reused') assert(['completed', 'reused'].includes(prior.status)
    && digest(prior.inputs) === digest(versions) && digest(prior.artifacts) === digest(artifacts), 'cannot reuse changed or missing evidence')
  const next = { status, inputs: versions, artifacts, conclusion, reason }
  workflow.states[stage] = next
  if (digest({ inputs: prior.inputs, artifacts: prior.artifacts }) !== digest({ inputs: versions, artifacts })) {
    const invalidated = new Set([stage])
    for (const s of config.stages) if (s.dependsOn.some(id => invalidated.has(id))) {
      invalidated.add(s.id)
      workflow.states[s.id] = { ...workflow.states[s.id], status: 'not_started', reason: `dependency changed: ${stage}` }
    }
  }
  return next
}
export function currentStage(config, workflow) {
  return config.stages.find(s => !['completed', 'reused', 'skipped'].includes(workflow.states[s.id].status)) ?? config.stages.at(-1)
}
