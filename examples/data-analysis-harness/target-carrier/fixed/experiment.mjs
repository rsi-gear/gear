import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, digest, seal, sourcePath, validCandidate } from './lib/contracts.mjs'
import { recordView, filterRecords, pageRecords, compareRecords } from './lib/records.mjs'
import { restoreWorkflow, updateStage, currentStage, stageUpdateInstructions } from './lib/workflow.mjs'
import { validateSearchPlan, resolvePipeline, validateResolved } from './lib/pipeline.mjs'
import { requestValidationDigest, experimentValidationDigest } from './lib/validation.mjs'

export async function initializeAnalysis(d) {
  d.workflowConfig = JSON.parse(await readFile(join(d.harness.root, 'workflow.yaml'), 'utf8'))
  d.toolInterface = JSON.parse(await readFile(join(d.harness.root, 'tools/experiment/interface.json'), 'utf8'))
  assert(d.toolInterface.version === 1 && d.toolInterface.actions.join(',') === 'search,get,compare,record,run,select', 'incompatible experiment interface')
  d.analysis = { timestamp: new Date().toISOString(), harness: d.harness.manifest.digest,
    dataset: d.request.task.inputs.trainDigest, checkpoint: d.checkpoint.digest, visibility: d.checkpoint.historyVisibilityDigest,
    toolVersion: digest(d.harness.manifest.artifacts.filter(f => f.path.startsWith('tools/experiment/'))),
    workflow: restoreWorkflow(d.workflowConfig, d.checkpoint.history, digest({ data: d.request.task.inputs, validation: requestValidationDigest(d.request) })),
    ...(d.roundCv ? { validation: { plan: d.plan, digest: digest(d.plan), rowIds: [], foldAssignments: [] } } : {}),
    stages: [], notes: [], artifacts: [], trace: [], plan: null, variants: [], trials: 0, fits: 0, fitCalls: 0,
    formalVariantId: null, decision: null, pluginCache: null }
  d.detailSnapshots = new Map()
  d.searchSnapshots = new Map()
}
export async function inspectAnalysis(d, { stage, resource, offset = 0 } = {}) {
  d.action ??= { action: d.checkpoint.history.length ? 'improve' : 'draft', parentExperimentId: d.checkpoint.history.at(-1)?.experimentId ?? null }
  if (resource === 'task') {
    const text = d.request.task.description
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length, 'invalid task offset')
    return { text: text.slice(offset, offset+8000), offset, totalCharacters: text.length, nextOffset: offset+8000 < text.length ? offset+8000 : null }
  }
  const selectedStage = stage ? d.workflowConfig.stages.find(s => s.id === stage) : currentStage(d.workflowConfig, d.analysis.workflow)
  assert(selectedStage, 'unknown workflow stage')
  const path = resource ?? selectedStage.prompt
  assert(path === selectedStage.prompt || /^skills\//.test(path), 'only current-stage guidance or a skill may be loaded')
  const artifact = d.harness.manifest.artifacts.find(f => f.path === path); assert(artifact, 'guidance is not sealed')
  const text = await readFile(join(d.harness.root, path), 'utf8')
  d.analysis.trace.push({ event: 'stage_guidance', stage: selectedStage.id, path, digest: artifact.digest })
  return { task: { id: d.request.task.taskId, description: d.request.task.description.slice(0, 2000),
      truncated: d.request.task.description.length > 2000, fullDescription: { resource: 'task', offset: 0 }, prediction: d.request.task.prediction },
    stage: selectedStage.id, stages: Object.fromEntries(Object.entries(d.analysis.workflow.states).map(([id, s]) => [id,
      { status: s.status, artifactCount: s.artifacts.length, conclusion: s.conclusion.slice(0, 200), truncated: s.conclusion.length > 200 }])),
    stageState: d.analysis.workflow.states[selectedStage.id],
    stageRecord: { tool: 'experiment', instructions: stageUpdateInstructions,
      example: { action: 'record', stage: { stage: selectedStage.id, status: 'completed',
        artifacts: ['<visible artifact digest>'], conclusion: '<observed findings and modeling implications>' } } },
    guidance: { path, digest: artifact.digest, text },
    budget: { experiments: { total: d.request.maxExperiments ?? 5, includingCurrent: (d.request.maxExperiments ?? 5)-d.request.slotIndex+1 }, resources: d.budget.available() },
    validation: d.validationSummary(), currentSolutionDigest: d.checkpoint.currentSolutionDigest,
    history: { total: d.checkpoint.history.length, visibility: d.checkpoint.historyVisibilityDigest, tool: 'experiment', action: 'search' },
    pipelineContract: 'task_inspect(resource="skills/data-analysis/SKILL.md")' }
}
function history(d) { return [...d.checkpoint.history, ...(d.evaluation ? [d.experiment()] : [])] }
function get(d, id) { const e = history(d).find(e => e.experimentId === id); assert(e, 'experiment outside authorized history'); return recordView(e) }
function summary(r) {
  return { id: r.identity.experimentId, goal: r.intent.hypothesis.slice(0, 240), truncated: r.intent.hypothesis.length > 240,
    status: r.execution.status, variant: r.formal_evaluation.variantId, score: r.formal_evaluation.score,
    decision: r.decision ? { disposition: r.decision.disposition, variantId: r.decision.variantId ?? null, innerWinner: r.decision.innerWinner ?? null } : null,
    cost: r.execution.cost, details: { action: 'get', experimentId: r.identity.experimentId } }
}
async function plugin(d, records, request, signal) {
  const directory = join(d.work, 'experiment-plugin'); await mkdir(directory, { recursive: true })
  const input = join(directory, 'input.json'), runner = join(directory, 'runner.py')
  await writeFile(input, JSON.stringify({ records, request }))
  await writeFile(runner, `import json,query,storage,render,records as schema\ns=json.load(open('/work/inputs/input.json'))\nif s['request'].get('note'): schema.validate_note(s['request']['note'])\nstorage.migrate('/work/inputs/cache',s['records'],'/work/scratch/cache')\nr={'ids':query.order(s['records'],s['request']),'views':{r['identity']['experimentId']:render.summary(r) for r in s['records']}}\njson.dump(r,open('/work/scratch/result.json','w'))\n`)
  const files = { 'runner.py': runner }
  const inputs = { 'input.json': input }
  const previous = d.analysis.pluginCache ?? [...d.checkpoint.history].reverse().find(e => e.analysis?.pluginCache)?.analysis.pluginCache
  if (previous) {
    const current = d.analysis.pluginCache?.digest === previous.digest
    const path = join(current ? d.output : d.data, 'objects', previous.digest.slice(7))
    assert((await import('./lib/contracts.mjs')).sha(await readFile(path)) === previous.digest, 'plugin cache changed')
    inputs[`cache/${previous.path.slice('cache/'.length)}`] = path
  }
  for (const f of d.harness.manifest.artifacts.filter(f => f.path.startsWith('tools/experiment/') && f.path.endsWith('.py')))
    files[f.path.slice('tools/experiment/'.length)] = join(d.harness.root, f.path)
  const result = await d.meteredWorker({ operation: 'script', files, entrypoint: 'runner.py', inputs, argv: [],
    outputDirectory: join(directory, 'output'), cpuSeconds: 5, wallSeconds: 10 }, signal)
  assert(result.exitCode === 0 && !result.limit, 'experiment plugin failed; raw records remain unchanged')
  const out = JSON.parse(await readFile(join(directory, 'output/result.json'), 'utf8'))
  const ids = records.map(r => r.identity.experimentId)
  assert(Array.isArray(out.ids) && out.ids.length === ids.length && new Set(out.ids).size === ids.length && out.ids.every(id => ids.includes(id)), 'plugin omitted or forged records')
  for (const path of result.outputFiles.filter(p => p.startsWith('cache/'))) {
    sourcePath(path)
    const id = await d.object(await readFile(join(directory, 'output', path)))
    d.analysis.pluginCache = { path, digest: id, version: d.toolInterface.storageVersion }
  }
  return out
}
export async function experimentTool(d, args, signal) {
  const { action } = args
  assert(d.analysis && d.toolInterface.actions.includes(action), 'unsupported experiment action')
  if (action === 'search') {
    let records, view, query = args
    if (args.cursor) {
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()), snapshot = d.searchSnapshots.get(cursor.signature)
      assert(snapshot, 'expired history cursor; start a new search')
      for (const [key, value] of Object.entries(args)) if (!['cursor', 'action'].includes(key)) assert(digest(value) === digest(snapshot.query[key]), 'history cursor filters changed')
      ;({ records, view } = snapshot); query = { ...snapshot.query, cursor: args.cursor }
    } else {
      records = filterRecords(history(d).map(recordView), args, { validation: requestValidationDigest(d.request), metric: d.request.task.prediction.metric ?? 'accuracy' })
      view = await plugin(d, records, args, signal)
      const byId = new Map(records.map(r => [r.identity.experimentId, r])); records = view.ids.map(id => byId.get(id))
    }
    const page = pageRecords(records, query)
    if (page.nextCursor && !args.cursor) d.searchSnapshots.set(JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString()).signature, { records, view, query })
    // Runtime facts remain alongside a clearly labeled editable view.
    return { ...page, records: page.records.map(r => ({ ...summary(r), pluginView: JSON.stringify(view.views?.[r.identity.experimentId] ?? {}).length <= 2000 ? view.views[r.identity.experimentId] : { omitted: true, reason: 'view exceeds 2000 characters; use get' } })) }
  }
  if (action === 'get') {
    if (args.artifactDigest) {
      const r = get(d, args.experimentId), artifact = r.artifacts_and_trace.artifacts.find(a => a.digest === args.artifactDigest)
      assert(artifact, 'artifact outside this experiment')
      const dir = r.identity.runId === d.runId ? d.output : d.data
      const bytes = await readFile(join(dir, 'objects', artifact.digest.slice(7)))
      assert((await import('./lib/contracts.mjs')).sha(bytes) === artifact.digest, 'artifact changed')
      const offset = args.offset ?? 0; assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length, 'invalid artifact offset')
      return { digest: artifact.digest, encoding: 'base64', totalBytes: bytes.length, offset, content: bytes.subarray(offset, offset+12000).toString('base64'), nextOffset: offset+12000 < bytes.length ? offset+12000 : null }
    }
    let offset = 0, content, key
    if (args.cursor) {
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString())
      assert(cursor.id === args.experimentId && cursor.sections === digest(args.sections ?? []), 'detail cursor mismatch')
      key = cursor.key; content = d.detailSnapshots.get(key); offset = cursor.offset
      assert(content && Number.isSafeInteger(offset) && offset >= 0 && offset <= content.length, 'expired detail cursor')
    } else {
      let record = get(d, args.experimentId)
      if (args.sections?.length) { assert(args.sections.every(s => Object.hasOwn(record, s)), 'unknown record section'); record = Object.fromEntries(args.sections.map(s => [s, record[s]])) }
      content = JSON.stringify(record); key = digest(content); d.detailSnapshots.set(key, content)
    }
    const end = Math.min(content.length, offset+12000)
    return { format: 'json', digest: key, totalCharacters: content.length, offset, content: content.slice(offset, end),
      nextCursor: end < content.length ? Buffer.from(JSON.stringify({ key, id: args.experimentId, sections: digest(args.sections ?? []), offset: end })).toString('base64url') : null }
  }
  if (action === 'compare') {
    if (args.variants) {
      assert(args.variants.length >= 2 && args.variants.length <= 20, 'compare requires 2..20 variants')
      const rows = args.variants.map(ref => {
        const r = get(d, ref.experimentId), variant = r.variants?.find(v => v.id === ref.variantId)
        assert(variant, 'variant is unknown or absent from this experiment')
        return { experimentId: ref.experimentId, variantId: ref.variantId, status: variant.status,
          innerScope: r.formal_evaluation.kind === 'round_five_fold_cv' ? r.scope.validation
            : r.plan ? digest({ dataset: r.scope.dataset, outer: r.scope.validation, validation: r.plan.validation, seed: r.plan.seed, metric: r.scope.metric }) : null,
          innerMeanUtility: variant.meanUtility, formalScore: r.formal_evaluation.variantId === ref.variantId ? r.formal_evaluation.score : null,
          model: variant.config.model, hyperparameters: variant.config.hyperparameters }
      })
      const comparable = rows.every(r => r.innerScope && r.innerMeanUtility !== null) && new Set(rows.map(r => r.innerScope)).size === 1
      return { phase: 'inner_validation', comparable, reason: comparable ? null : 'unknown or incompatible training evidence; no ranking', rows }
    }
    assert(Array.isArray(args.experimentIds), 'experimentIds or variants required')
    return compareRecords(args.experimentIds.map(id => get(d, id)))
  }
  if (action === 'record') {
    assert(!args.score && !args.execution && !args.formal_evaluation, 'notes cannot set authoritative scores')
    if (args.note) {
      assert(args.note && Object.keys(args.note).every(k => ['text', 'next', 'correctionOf', 'extensions'].includes(k))
        && typeof args.note.text === 'string' && args.note.text.length <= 4000, 'notes may only append interpretation and extensions')
      await plugin(d, [], { note: args.note }, signal)
      const note = { id: `note-${d.analysis.notes.length+1}`, source: 'agent', ...args.note }
      if (note.correctionOf) assert(d.analysis.notes.some(n => n.id === note.correctionOf), 'correction must reference an existing note')
      d.analysis.notes.push(note)
      const bytes = Buffer.from(JSON.stringify(note)), id = await d.object(bytes)
      d.analysis.artifacts.push({ path: `${note.id}.json`, digest: id, bytes: bytes.length, source: 'agent_note' })
    }
    if (args.stage) {
      const evidence = [...d.analysis.artifacts, ...d.checkpoint.history.flatMap(e => e.analysis?.artifacts ?? [])]
      const refs = new Set(evidence.map(a => a.digest))
      if (args.stage.status === 'completed' && args.stage.stage === 'eda')
        assert(Array.isArray(args.stage.artifacts) && args.stage.artifacts.some(ref => evidence.some(a =>
          a.digest === ref && a.source === 'analysis' && a.executionStatus !== 'failed')),
        'EDA completion requires observed analysis output from a successful script, not code or notes alone')
      if (args.stage.status === 'completed' && !['task', 'validation'].includes(args.stage.stage))
        assert((args.stage.artifacts ?? []).some(ref => evidence.some(a => a.digest === ref && ['analysis', 'analysis_code', 'runtime'].includes(a.source))),
          'this stage requires an observed analysis/code/execution artifact, not only an agent note')
      updateStage(d.workflowConfig, d.analysis.workflow, args.stage, refs)
      d.analysis.stages = [...new Set([...d.analysis.stages, args.stage.stage])]
    }
    await d.persist()
    return { notes: d.analysis.notes.slice(-1), artifacts: d.analysis.artifacts.slice(-1), workflow: d.analysis.workflow }
  }
  if (action === 'run') return runExperiment(d, args, signal)
  if (action === 'select') {
    assert(d.evaluation && d.selection === undefined, 'run or reuse before selection; select once')
    if (!args.experimentId && d.state('select').eligibleExperiments.length === 0) {
      d.selection = null; d.selectedAt = new Date().toISOString()
      d.analysis.decision = { disposition: 'no_eligible_pipeline', source: 'runtime', reason: args.reason ?? '' }
      await d.persist(); return d.analysis.decision
    }
    const e = history(d).find(e => e.experimentId === args.experimentId)
    assert(validCandidate(e) && experimentValidationDigest(e) === requestValidationDigest(d.request), 'selection lacks compatible formal evidence')
    const solution = [d.solution, ...d.checkpoint.solutions].find(s => s?.digest === e.sourceDigest)
    assert(solution?.protocol === 'analysis-solution@2' && solution.parameters.variantId === args.variantId, 'select the evaluated resolved variant')
    assert(d.state('select').eligibleExperiments.some(p => p.experimentId === e.experimentId), 'selection outside sequence candidate pool')
    validateResolved(solution.parameters)
    d.selection = solution.digest; d.selectedAt = new Date().toISOString()
    d.analysis.decision = { experimentId: e.experimentId, variantId: args.variantId, resolvedPipeline: solution.parameters,
      disposition: d.selection === d.checkpoint.currentSolutionDigest ? 'retained_incumbent' : 'adopted', reason: args.reason ?? '', source: 'agent' }
    await d.persist(); return d.analysis.decision
  }
}
async function runExperiment(d, args, signal) {
  assert(typeof args.hypothesis === 'string' && args.hypothesis.trim() && typeof args.intendedChange === 'string', 'hypothesis and intendedChange required')
  const plan = validateSearchPlan(args.plan, { roundValidation: d.roundCv ? d.plan : null }), key = digest({ plan, hypothesis: args.hypothesis, intendedChange: args.intendedChange })
  if (d.started) { assert(d.runKey === key && d.evaluation, 'experiment already started; inspect existing outcome'); return { experimentId: `${d.runId}/experiment`, status: d.evaluation.status, reusedRequest: true } }
  assert(d.action && (d.holdout || d.roundCv), 'inspect first; workflow requires a prepared validation task')
  assert(plan.variants.every(v => v.config.seed === plan.seed), 'variant seed differs from the declared plan')
  const files = await d.sourceFiles(); assert(files[plan.entrypoint], 'missing pipeline factory')
  d.started = true; d.runKey = key; d.claim = { hypothesis: args.hypothesis, intendedChange: args.intendedChange }; d.analysis.plan = plan
  await d.persist()
  const entries = []
  for (const [path, file] of Object.entries(files).sort()) { const bytes = await readFile(file); entries.push({ path, digest: await d.object(bytes), bytes: bytes.length }) }
  const result = await d.meteredWorker({ operation: 'research', files, entrypoint: plan.entrypoint, searchPlan: plan,
    train: join(d.data, 'train.csv'), prediction: d.request.task.prediction, validationPlan: d.plan,
    publicFiles: d.request.task.publicFiles ?? [], publicDirectory: join(d.data, 'public'), outputDirectory: join(d.work, 'research-output'),
    wallSeconds: d.request.experimentWallSeconds, cpuSeconds: d.request.experimentCpuSeconds }, signal)
  d.evaluation = result
  if (d.roundCv && result.cv) {
    Object.assign(d.analysis.validation, result.cv)
    const bytes = Buffer.from(JSON.stringify(d.analysis.validation)), id = await d.object(bytes)
    d.analysis.artifacts.push({ path: 'cv-folds.json', digest: id, bytes: bytes.length, source: 'runtime' })
  }
  Object.assign(d.analysis, { variants: result.variants, trials: result.variants.length, fits: result.fits, fitAttempts: result.fitAttempts ?? result.fits, fitCalls: result.fitCalls, formalVariantId: result.formalVariantId })
  if (result.formalVariantId) {
    const resolved = resolvePipeline({ plan, variantId: result.formalVariantId, experimentId: `${d.runId}/experiment`, codeDigest: digest(entries), runtimeDigest: d.request.runtimeDigest, actualParameters: result.formalFit?.parametersBefore ?? result.variants.find(v => v.id === result.formalVariantId)?.folds[0]?.fit.parametersBefore })
    d.solution = seal({ protocol: 'analysis-solution@2', files: entries, entrypoint: plan.entrypoint, parameters: resolved,
      trainingSeed: plan.seed, runtimeDigest: d.request.runtimeDigest, authoredByRunId: d.runId })
  }
  const predictionsPath = result.oofPath ?? result.predictionsPath
  d.oofDigest = predictionsPath ? await d.object(await readFile(predictionsPath)) : null
  d.internalReceipt = seal({ protocol: d.roundCv ? 'analysis-cv-receipt@2' : 'analysis-validation-receipt@2', requestDigest: d.request.digest, sourceDigest: d.solution?.digest ?? null,
    validationPlanDigest: digest(d.plan), variantId: result.formalVariantId, status: result.status, ...d.validationResult(result), formalFit: result.formalFit })
  const diagnostics = Buffer.from(JSON.stringify(result)), artifact = await d.object(diagnostics)
  const runtimeArtifact = { path: 'research-result.json', digest: artifact, bytes: diagnostics.length, source: 'runtime' }
  d.analysis.artifacts.push(runtimeArtifact)
  d.analysis.decision = { innerWinner: result.formalVariantId, disposition: result.status === 'completed' ? 'pending_selection' : 'candidate_failed' }
  await writeFile(join(d.output, d.roundCv ? 'cv-receipt.json' : 'validation-receipt.json'), JSON.stringify(d.internalReceipt))
  await d.persist()
  return { experimentId: `${d.runId}/experiment`, status: result.status, variantId: result.formalVariantId,
    artifacts: [runtimeArtifact],
    score: d.roundCv ? result.meanScore : result.validationScore, ...(d.roundCv ? { stdScore: result.stdScore, evaluation: 'round_five_fold_cv', validationDigest: digest(d.plan) } : {}),
    fits: result.fits, fitCalls: result.fitCalls, trials: result.variants.map(v => ({ id: v.id, status: v.status, meanUtility: v.meanUtility })), details: { action: 'get', experimentId: `${d.runId}/experiment` } }
}
