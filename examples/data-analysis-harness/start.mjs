#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cli, isMain, command } from '../kaggle-titanic/common.mjs'
import { compilerEnvironment } from '../kaggle-titanic/start.mjs'
import { json, atomicJson, Store } from './lib/store.mjs'
import { assert, digest } from './lib/contracts.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { ResearchProject } from './lib/project.mjs'
import { AnalysisSearchProvider, implementationDigest, objective } from './lib/search-provider.mjs'
import { ConfigSchema } from '../../lib/config.js'
import { digestDatasetRef } from '../../lib/state/dataset.js'
import { defaultSearchConfig, defaultMultisignalPromotion } from '../../lib/search/config.js'
import { componentRef } from '../../lib/evolution/components.js'
import { HitchCliEvaluator } from '../../lib/evaluator/hitch-cli.js'
import { createSkillControlPlane } from '../../lib/skill/control-plane.js'

export async function outerDataset(directory, project, checkpoint, provider) {
  const task = join(directory, project.task.taskId)
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'task.toml'), 'version = "1.0"\n[verifier]\ntimeout_sec = 60\n')
  await writeFile(join(task, 'instruction.md'), `analysis-five-rollout@1\n${project.task.description}\nOne cell = five sequential experiments. Shared public checkpoint: ${checkpoint.digest}. This is development evidence. Improve the general research harness.\n`)
  const body = { schema_version: '1', kind: 'gear-harbor-benchmark', benchmark: { id: 'analysis-sequence', revision: checkpoint.digest },
    adapter: { id: 'analysis-five-rollout', revision: provider.integrity, output_protocol: 'gear-harbor-eval-result-v1' },
    raw_metrics: { schema_version: '1', metrics: provider.raw.map(({ schemaVersion: _, digest: _d, ...m }) => m) },
    scoring: { total_score: { source_metric: 'total_score', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } },
    tasks: [{ task_id: project.task.taskId, task_digest: await digestDatasetRef(task) }] }
  await atomicJson(join(directory, 'benchmark.adapter.json'), { ...body, dataset_digest: digest(body) })
  return directory
}
export async function buildControl(base, project, directory, { checkpointRef, fromHarness, maxCandidates = 1 } = {}) {
  const store = new Store(join(directory, 'research')), backend = new HitchBackend(store, project.backend), controller = new ResearchProject(store, project)
  const head = await store.load('projects', project.projectId), checkpoint = await store.get(checkpointRef ?? head.checkpoint)
  if (!fromHarness) {
    const event = head.stage ? await store.get(head.stage) : null
    const commit = event?.adoptedCommit ?? project.harness.commit
    const manifest = JSON.parse(await command('git', ['show', `${commit}:harness/manifest.json`], { cwd: project.targetRepository }))
    fromHarness = { commit, manifestDigest: manifest.digest }
  }
  const { sequencePlan } = await import('./lib/sequence.mjs')
  await backend.admit(sequencePlan({ task: project.task, checkpoint, harness: fromHarness, model: project.model,
    budget: project.budget, runtimeDigest: project.task.runtimeDigest }))
  const provider = new AnalysisSearchProvider(store, backend, project, checkpoint, {
    reserveSequence: plan => controller.reserveSequence(plan), settleSequence: (plan, receipt) => controller.settleSequence(plan, receipt),
  })
  const implementation = await implementationDigest()
  provider.integrity = digest({ implementation, conditions: provider.integrity })
  provider.conditionDigest = digest({ provider: provider.integrity, task: project.task.digest, checkpoint: checkpoint.digest, repetitions: 1 })
  const cohort = join(directory, 'cohorts', checkpoint.digest.slice(7))
  const dataset = await outerDataset(join(cohort, 'tasks'), project, checkpoint, provider)
  const compiler = await compilerEnvironment(base.compiler)
  const maxSeconds = (maxCandidates + 1) * project.budget.wallSeconds + 1800
  const limits = { maxNewRolloutCells: maxCandidates + 1, maxDiagnosisInputTokens: 100000, maxDiagnosisOutputTokens: 20000,
    maxRepairCells: 0, timeoutMs: maxSeconds * 1000 }
  const config = ConfigSchema({ ...base, workspaceRoot: join(cohort, 'control'), stateRoot: join(cohort, 'state'),
    dshRepository: project.targetRepository, targetRoot: 'harness', dshBaseRef: project.dshBaseRef,
    initialChampion: { schemaVersion: 2, ref: fromHarness.commit, manifestDigest: fromHarness.manifestDigest, updatedAt: new Date().toISOString() },
    toolchainRef: 'analysis-dsh-cpu-v1', sandboxProfileRef: 'analysis-chroot-v1', seedTaskRef: dataset, heldOutRef: dataset,
    evaluationMode: 'reuse-seed', taskBudgetMs: project.budget.wallSeconds * 1000,
    candidateWorkspace: { ...base.candidateWorkspace, shellEnabled: false },
    candidateGeneration: { ...Object.fromEntries(Object.entries(base.candidateGeneration).filter(([k]) => !['maxTokens', 'maxModelRequests'].includes(k))), maxCandidates },
    compiler: { command: process.execPath, args: [join(project.targetRepository, 'fixed/check.mjs')], timeoutMs: 60000,
      env: compiler.env, readPaths: [...new Set([project.targetRepository, ...compiler.readPaths])] },
    hitch: { ...base.hitch, executable: project.backend.executable, root: project.backend.root, harnessId: 'deepseek', model: project.model,
      attempts: 1, maxConcurrent: 1, controlPlane: { mode: 'direct', requireModelCapture: false } },
    search: { ...structuredClone(defaultSearchConfig), parentBatchCount: 1,
      diagnosis: { ...defaultSearchConfig.diagnosis, candidatesPerFamily: 1 },
      taskSetSizing: { basis: 'seed-universe', rounding: 'ceil', local: { ratio: 1 }, shared: { ratio: 0 }, cross: { ratio: 0 }, bridge: { ratio: 1 } },
      scopeSampling: { bucketWeights: { local: 1, shared: 0, cross: 0 }, epochPolicy: 'stable' }, process: { mode: 'off', parentBudgetFraction: 0 } },
    promotion: { ...structuredClone(defaultMultisignalPromotion), validationMode: 'shared-set-research', allowSharedSetPromotion: true,
      objective: { minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 }, process: { mode: 'off', minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 } },
    budgets: { round: limits, evolution: limits },
  })
  const raw = new HitchCliEvaluator({ ...config.hitch, executable: project.backend.executorExecutable, repositoryPath: project.targetRepository })
  const evaluator = new Proxy(raw, { get(target, property) {
    if (property === 'search') return { provider, diagnosis: provider.diagnosis }
    if (property === 'evaluate') return async () => { throw new Error('analysis requires staged sequence execution') }
    if (property === 'resolveVerifierRun') return async (_evalId, runId, signal) => {
      signal.throwIfAborted(); const index = await store.load('seed-runs', runId); assert(index, 'run outside authorized seed sequence')
      const cell = await store.load('cells', index.cellKey); assert(await provider.verifyCell(cell.cell, cell.cell.identity), 'seed sequence artifacts unavailable')
      const state = await store.load('sequences', cell.plan.digest.slice(7)), step = state.steps.find(s => s.runId === runId)
      assert(step, 'run not a research child')
      const op = await store.load('executions', step.requestDigest.slice(7)); return { evalId: op.evalId, attempt: 1, ...(op.trial.trial_name ? { trialName: op.trial.trial_name } : {}) }
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const rolloutProvider = componentRef('rollout-provider', 'analysis-five-rollout', { package: 'gear/examples/data-analysis-harness', version: '1', integrity: implementation },
    { checkpoint: checkpoint.digest, task: project.task.digest, model: project.model, budget: project.budget, executorCommit: project.backend.executorCommit })
  await mkdir(config.workspaceRoot, { recursive: true }); await atomicJson(join(cohort, 'gear.config.json'), config)
  return { config, evaluator, rolloutProvider, provider, cohort,
    budgetPreview: { sequences: maxCandidates + 1, researchRollouts: 5 * (maxCandidates + 1), deliveries: maxCandidates + 1,
      sequenceWallSeconds: project.budget.wallSeconds, sequenceCpuSeconds: project.budget.cpuSeconds, model: project.modelAccounting } }
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, config: { type: 'string' }, 'prepare-only': { type: 'boolean' } } })
  assert(v.project && v.config, '--project and --config required')
  const directory = resolve(v.project), project = await json(join(directory, 'project.json'))
  const built = await buildControl(await json(resolve(v.config)), project, directory)
  console.log(JSON.stringify({ budgetPreview: built.budgetPreview, cohort: built.cohort }))
  if (v['prepare-only']) return
  const control = await createSkillControlPlane(built.config, { evaluator: built.evaluator, rolloutProvider: built.rolloutProvider })
  try {
    const admission = await control.gateway.call('control.start', { name: 'Data analysis harness development', rounds: 1, objective })
    await atomicJson(join(built.cohort, 'admission.json'), admission)
    console.log(JSON.stringify({ admission, socketPath: control.socketPath, metaIdentity: await control.gateway.call('control.identity', {}) }))
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } finally { await control.dispose() }
}
if (isMain(import.meta.url)) cli(main)
