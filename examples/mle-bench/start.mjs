#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli, isMain } from './lib/common.mjs'
import { json, atomicJson, optionalJson, Store } from './lib/store.mjs'
import { researchConfig } from './lib/research-config.mjs'
import { assert, digest } from './lib/contracts.mjs'
import { metrics, objective } from './lib/operation-provider.mjs'
import { copyRegisteredTarget, carrierForTarget } from './lib/target-source.mjs'
import { createProjectControlPlane, saveProfile } from '../../lib/index.js'

async function immutableJson(path, value) {
  const previous = await optionalJson(path)
  if (previous) { assert(digest(previous) === digest(value), `project configuration changed: ${path}`); return }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
async function installProfile(profile) {
  const name = `analysis-${digest(profile).slice(7, 39)}`
  try { await saveProfile(name, profile) }
  catch (error) { if (error.code !== 'profile-exists') throw error }
  return name
}

/** Build a standard Gear project; all execution, promotion and recovery use current Project APIs. */
export async function buildProject(directory, { metaProfile, checkpointRef, registered, stageId, maxCandidates = 1, passEnv = [] } = {}) {
  directory = resolve(directory)
  const project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const head = await store.load('projects', project.projectId)
  checkpointRef ??= head.checkpoint
  const checkpoint = await store.get(checkpointRef)
  const research = researchConfig(project.research)
  if (!registered) {
    const event = head.stage ? await store.get(head.stage) : null
    const commit = event?.adoptedCommit ?? project.harness.commit
    const { command } = await import('./lib/common.mjs')
    const manifest = JSON.parse(await command('git', ['show', `${commit}:harness/manifest.json`], { cwd: project.targetRepository }))
    registered = [{ commit, manifestDigest: manifest.digest }]
  }
  assert(registered.length === 1 || registered.length === 2, 'one anchor or two registered methods required')
  assert(registered.length === 2 || metaProfile, '--meta-profile is required for autonomous refinement')
  assert(Number.isSafeInteger(maxCandidates) && maxCandidates > 0, 'maxCandidates must be positive')
  if (registered.length === 2) assert(maxCandidates === 1, 'registered comparison has exactly one candidate')
  const cohort = join(directory, 'cohorts', digest({ checkpointRef, registered, stageId: stageId ?? null }).slice(7))
  const configuration = { project: directory, projectDigest: digest(project), checkpointRef, registered }
  const profile = { command: [process.execPath, fileURLToPath(new URL('./provider.mjs', import.meta.url))],
    workingDirectory: fileURLToPath(new URL('../../', import.meta.url)), configuration,
    passEnv: [...new Set(['HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GEAR_TARGET_CODEX_AUTH_FILE', 'GEAR_DSH_CODEX_MODULE', ...passEnv])].sort(),
    timeoutMs: Math.ceil((project.budget.wallSeconds + 300) * 1000) }
  const targetProfile = await installProfile(profile)
  const config = { version: 1, benchmark: 'benchmark.yaml', target: { adapter: 'dsh', path: 'target', profile: targetProfile },
    meta: { profile: registered.length === 2 ? targetProfile : metaProfile }, algorithm: 'gepa', objective, metrics: metrics(project.task),
    validation: { mode: 'research' }, evaluation: { repair: { max_retries: 0, max_projections: 0, backoff_ms: [0] } },
    budget: { rounds: 1, max_evaluations: maxCandidates + 1, max_candidates: maxCandidates, repetitions: 1 } }
  const existing = await optionalJson(join(cohort, 'gear.yaml'))
  if (!existing) await copyRegisteredTarget(project.targetRepository, registered[0], join(cohort, 'target'))
  await immutableJson(join(cohort, 'gear.yaml'), config)
  await immutableJson(join(cohort, 'benchmark.yaml'), { version: 1, source: 'tasks.jsonl', template: 'text' })
  const guidance = await readFile(new URL('./meta-task-context.txt', import.meta.url), 'utf8')
  const task = { id: project.task.taskId, family: project.task.taskFamilyId, split: 'seed', expected: 'sequence-receipt',
    instruction: `analysis-research-sequence@1\n${project.task.description}\nEach method receives ${research.maxExperiments} sequential experiment slots from checkpoint ${checkpoint.digest}. `
      + 'Optimize prompts, skills and workflows/research/{policy.py,memory.py,policy.json}. Preserve the empty preset and fixed carrier. '
      + 'The provider executes and scores the final selected source. All experiments use the same held-out validation set. Internal CV is an optional training choice. This is shared-set development evidence.\n\n' + guidance }
  const row = JSON.stringify(task) + '\n'
  try { await writeFile(join(cohort, 'tasks.jsonl'), row, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert(await readFile(join(cohort, 'tasks.jsonl'), 'utf8') === row, 'frozen task changed') }
  return { cohort, config, project, store, checkpoint, registered, configuration,
    budgetPreview: { sequences: maxCandidates + 1, experimentsPerHarness: research.maxExperiments, researchRollouts: research.maxExperiments * (maxCandidates + 1),
      validation: { mode: project.task.protocol === 'analysis-task@3' ? 'holdout' : 'legacy-cv', ...research.validation },
      deliveries: maxCandidates + 1, repetitions: 1, sequenceWallSeconds: project.budget.wallSeconds,
      sequenceCpuSeconds: project.budget.cpuSeconds, experimentWallSeconds: project.budget.experimentWallSeconds,
      experimentCpuSeconds: project.budget.experimentCpuSeconds, model: project.modelAccounting } }
}

export async function retainedHarness(built, report) {
  return carrierForTarget(built.store, built.project, join(built.cohort, '.gear/runs', report.run_id, 'targets', report.retained), built.registered)
}
// macOS Unix sockets cannot accommodate a deep project path plus a full cohort digest.
export async function openProjectControl(cohort) {
  const socketRoot = await mkdtemp(join(tmpdir(), 'gear-analysis-'))
  let control
  try { control = await createProjectControlPlane(cohort, { socketPath: join(socketRoot, 'control.sock') }) }
  catch (error) { await rm(socketRoot, { recursive: true, force: true }); throw error }
  return { ...control, async dispose() {
    try { await control.dispose() } finally { await rm(socketRoot, { recursive: true, force: true }) }
  } }
}
export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, 'meta-profile': { type: 'string' },
    'prepare-only': { type: 'boolean' }, resume: { type: 'string' } } })
  assert(v.project, '--project required')
  const built = await buildProject(resolve(v.project), { metaProfile: v['meta-profile'] })
  console.log(JSON.stringify({ budgetPreview: built.budgetPreview, project: built.cohort }))
  if (v['prepare-only']) return
  const control = await openProjectControl(built.cohort)
  try {
    const admissionPath = join(built.cohort, 'admission.json')
    const saved = await optionalJson(admissionPath)
    const admission = saved ?? await control.application.admitRefine()
    if (v.resume) assert(v.resume === admission.runId, 'resume must match the admitted cohort run')
    await atomicJson(admissionPath, admission)
    const { withOperatorCancellation } = await import('./lib/deadline.mjs')
    const report = await withOperatorCancellation(signal => control.application.resume(admission.runId, signal))
    console.log(JSON.stringify({ report, retainedHarness: await retainedHarness(built, report) }, null, 2))
  } finally { await control.dispose() }
}
if (isMain(import.meta.url)) cli(main)
