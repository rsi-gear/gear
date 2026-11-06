#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { cp, mkdir, readFile, writeFile, copyFile, chmod, stat } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command, isMain, cli } from './lib/common.mjs'
import { files, hash } from './target-carrier/fixed/integrity.mjs'
import { atomicJson, json, Store } from './lib/store.mjs'
import { researchBudget, digest, initialCheckpoint, seal, sha, assert } from './lib/contracts.mjs'
import { executionBinding, refitBinding } from './lib/hitch-backend.mjs'
import { importMlebench, fileHash } from './lib/mlebench.mjs'
import { researchConfig } from './lib/research-config.mjs'
export const here = dirname(fileURLToPath(import.meta.url))

export async function sealHarness(repository, base, parent) {
  const root = join(repository, 'harness'), artifacts = []
  for (const path of (await files(root)).filter(f => f !== 'manifest.json')) {
    const bytes = await readFile(join(root, path)); artifacts.push({ path, digest: hash(bytes), bytes: bytes.length })
  }
  const body = { schemaVersion: 1, ...(parent ? { parentRef: parent } : {}), dshBaseRef: base,
    toolchainRef: 'analysis-dsh-cpu-v1', sandboxProfileRef: 'analysis-chroot-v1', artifacts }
  const manifest = { ...body, digest: hash(JSON.stringify(body)) }
  // Gear harness manifest v1 hashes JSON insertion order (including artifact
  // entries); research CAS canonicalization is a different protocol.
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest
}
export async function bootstrap(repository, install = false) {
  await cp(join(here, 'target-carrier'), repository, { recursive: true, force: false, errorOnExist: true })
  await mkdir(join(repository, 'fixed/lib'), { recursive: true })
  for (const name of ['contracts.mjs', 'schemas.mjs', 'metrics.mjs', 'budget.mjs', 'store.mjs', 'research-config.mjs']) await copyFile(join(here, 'lib', name), join(repository, 'fixed/lib', name))
  await writeFile(join(repository, '.gitignore'), 'node_modules/\n__pycache__/\n*.pyc\n')
  await mkdir(join(repository, 'apps/cli/lib'), { recursive: true })
  await copyFile(join(repository, 'fixed/launcher.mjs'), join(repository, 'apps/cli/lib/bin.js'))
  await chmod(join(repository, 'apps/cli/lib/bin.js'), 0o755)
  const git = args => command('git', args, { cwd: repository })
  await git(['init', '-b', 'codex/analysis-target']); await git(['config', 'user.name', 'Gear Analysis']); await git(['config', 'user.email', 'gear-analysis@localhost'])
  await sealHarness(repository, '0'.repeat(40))
  if (install) await command('pnpm', ['install', '--frozen-lockfile'], { cwd: repository })
  await git(['add', '.']); await git(['commit', '--no-gpg-sign', '-m', 'Initialize fixed analysis carrier'])
  const base = await git(['rev-parse', 'HEAD']), manifest = await sealHarness(repository, base, base)
  await git(['add', 'harness/manifest.json']); await git(['commit', '--no-gpg-sign', '-m', 'Seal initial research harness'])
  return { targetRepository: repository, dshBaseRef: base, harness: { commit: await git(['rev-parse', 'HEAD']), manifestDigest: manifest.digest } }
}

export async function prepare(options) {
  assert(options.competition && options.mlebenchRepository && options.mlebenchData,
    'MLE-bench repository, data root and competition are required')
  assert(!!options.deploymentTrain === !!options.deploymentPredict, 'both deployment inputs are required')
  const research = researchConfig(options.research)
  const out = resolve(options.out)
  assert(!await stat(out).catch(e => { if (e.code !== 'ENOENT') throw e; return null }), 'output must be new')
  await mkdir(out, { recursive: true })
  const data = join(out, 'data')
  const prepared = await importMlebench({ repository: options.mlebenchRepository, dataRoot: options.mlebenchData,
    competition: options.competition, python: options.python, fixture: options.fixture, research }, data)
  const validation = await json(join(data, 'validation.json'))
  let refit = { train: prepared.train, predict: prepared.predict, predictIds: prepared.refitIds, scope: 'mle-bench-public' }
  if (options.deploymentTrain) {
    assert(prepared.publicFiles.every(f => f.role === 'shared'), 'deployment assets require a separately registered task')
    await mkdir(join(data, 'deployment'))
    await copyFile(resolve(options.deploymentTrain), join(data, 'deployment/train.csv'))
    await copyFile(resolve(options.deploymentPredict), join(data, 'deployment/predict.csv'))
    await atomicJson(join(data, 'deployment/prediction.json'), prepared.prediction)
    const deployment = JSON.parse(await command(options.python ?? 'python3', [join(here, 'mlebench-deployment.py'), '--directory', join(data, 'deployment')]))
    refit = { train: join(data, 'deployment/train.csv'), predict: join(data, 'deployment/predict.csv'),
      predictIds: deployment.predictIds, scope: 'kaggle-official-deployment' }
    prepared.rows.refitTrain = deployment.trainRows; prepared.rows.refitPredict = deployment.predictIds.length
  }
  const runtime = { image: options.baseImage, platform: options.platform, cpus: 2, memoryMiB: 4096,
    workerDigest: sha(await readFile(join(here, 'target-carrier/fixed/worker.py'))), confinementDigest: sha(await readFile(join(here, 'target-carrier/fixed/confinement.py'))),
    scoringDigest: sha(await readFile(join(here, 'target-carrier/fixed/scoring.py'))) }
  const family = options.competition
  const task = seal({ protocol: 'analysis-task@3', taskId: `${family}-development`, taskFamilyId: family,
    description: options.description ?? prepared.description,
    inputs: { trainDigest: await fileHash(prepared.train), predictDigest: await fileHash(prepared.predict) },
    prediction: prepared.prediction, predictIds: prepared.predictIds, validationPlanDigest: digest(validation), runtimeDigest: digest(runtime),
    publicFiles: prepared.publicFiles, benchmark: prepared.benchmark })
  const target = await bootstrap(join(out, 'target'), options.install)
  const store = new Store(join(out, 'research')), projectId = options.projectId ?? `research-${task.digest.slice(7, 23)}`
  const checkpoint = initialCheckpoint({ researchProjectId: projectId, taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
    dataScopeDigest: digest({ inputs: task.inputs, benchmark: task.benchmark }), validationPlanDigest: digest(validation),
    runtimeDigest: task.runtimeDigest, scorerDigest: digest({ metric: task.prediction.metric, scoringDigest: runtime.scoringDigest }) })
  const checkpointRef = await store.put(checkpoint)
  await store.save('projects', projectId, { checkpoint: checkpointRef, stage: null, previousStage: null })
  const budget = researchBudget(research), maxSequences = 12
  const project = { protocol: 'analysis-project@1', projectId, ...target, task, runtime, research, validationPlan: validation, checkpointRef,
    rows: prepared.rows, model: options.model, budget,
    modelAccounting: { mode: 'usage-only', requestCoverage: 'adapter-calls-lower-bound', price: 'unknown' },
    projectLimits: { maxSequences, cpuSeconds: maxSequences * budget.cpuSeconds, wallSeconds: maxSequences * budget.wallSeconds },
    backend: { executable: resolve(options.hitchExecutable), executorExecutable: resolve(options.executorExecutable),
      root: resolve(options.hitchRoot), workDirectory: out, hitchRepository: resolve(options.hitchRepository),
      targetRepository: target.targetRepository, executorRepository: resolve(options.executorRepository ?? options.hitchRepository), executorCommit: options.executorCommit,
      baseImage: options.baseImage, platform: options.platform, runtimeDigest: task.runtimeDigest, model: options.model,
      passEnv: options.model.startsWith('openai-codex/') ? ['DSH_OPENAI_CODEX_ACCESS_B64', 'GEAR_TARGET_CODEX_ENV'] : [],
      train: prepared.train, predict: prepared.predict, expected: prepared.expected, validationPlan: validation,
      publicDirectory: prepared.publicDirectory, publicFiles: prepared.publicFiles, refit } }
  await atomicJson(join(out, 'project.json'), project)
  await store.save('bindings', 'execution', await executionBinding(project.backend))
  await store.save('bindings', 'refit', await refitBinding(project.backend))
  return project
}
export async function main() {
  const required = ['out', 'mlebench-repository', 'mlebench-data', 'competition', 'hitch-repository', 'hitch-root',
    'hitch-executable', 'executor-executable', 'executor-commit', 'base-image', 'platform', 'model']
  const names = [...required, 'description', 'executor-repository', 'python', 'deployment-train', 'deployment-predict', 'research-config']
  const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(k => [k, { type: 'string' }])), install: { type: 'boolean' } } })
  for (const key of required) assert(values[key], `--${key} required`)
  const options = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]))
  if (options.researchConfig) options.research = await json(resolve(options.researchConfig))
  console.log(JSON.stringify(await prepare(options), null, 2))
}
if (isMain(import.meta.url)) cli(main)
