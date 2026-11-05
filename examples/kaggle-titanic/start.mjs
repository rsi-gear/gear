#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { atomicJson, cli, command, fullFoldSettings, hash, isMain, objective, readJson, requireArtifacts } from './common.mjs'

export async function buildConfig(base, project, directory) {
  const lock = await command('git', ['ls-tree', project.initialChampion.ref, '--', 'pnpm-lock.yaml'], { cwd: project.targetRepository })
  if (!/^100(?:644|755) blob [a-f0-9]{40,64}\tpnpm-lock\.yaml$/u.test(lock)) throw new Error('prepared carrier has no committed pnpm-lock.yaml; restore the frozen carrier template before preparing')
  if (base.hitch?.sampling?.temperature !== undefined) throw new Error('Kaggle Hitch direct mode does not support sampling.temperature')
  if (!isAbsolute(base.hitch?.executable ?? '')) throw new Error('base config hitch.executable must be an absolute executable path')
  if (hash(await readFile(project.competitionFile)) !== project.competitionDigest) throw new Error('competition configuration changed')
  const { ConfigSchema } = await import('../../lib/config.js')
  const { defaultSearchConfig, defaultMultisignalPromotion } = await import('../../lib/search/config.js')
  const tasks = await readJson(join(project.seedTaskRef, 'benchmark.adapter.json'))
  const limits = { maxNewRolloutCells: 128, maxDiagnosisInputTokens: 100000, maxDiagnosisOutputTokens: 20000,
    maxRepairCells: 12, timeoutMs: 3600000 }
  return ConfigSchema({ ...base,
    workspaceRoot: resolve(directory, 'control'), stateRoot: resolve(directory, 'state'),
    dshRepository: project.targetRepository, targetRoot: 'harness', dshBaseRef: project.dshBaseRef,
    initialChampion: project.initialChampion, toolchainRef: 'kaggle-dsh-cpu-v1', sandboxProfileRef: 'kaggle-chroot-v1',
    seedTaskRef: project.seedTaskRef, heldOutRef: project.heldOutRef, taskBudgetMs: base.taskBudgetMs ?? 600000,
    candidateWorkspace: { ...base.candidateWorkspace, shellEnabled: false },
    compiler: { command: process.execPath, args: [join(project.targetRepository, 'fixed/check.mjs')],
      timeoutMs: 60000, env: { PATH: process.env.PATH ?? '' }, readPaths: [project.targetRepository] },
    hitch: { ...base.hitch, harnessId: 'deepseek', root: project.hitchRoot, attempts: 1, maxConcurrent: 2,
      controlPlane: { mode: 'direct', requireModelCapture: false } },
    search: { ...structuredClone(defaultSearchConfig), ...fullFoldSettings(tasks.tasks.map(task => task.task_id)), process: { mode: 'off', parentBudgetFraction: 0 } },
    promotion: { ...structuredClone(defaultMultisignalPromotion), process: { mode: 'off', minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 } },
    budgets: base.budgets ?? { round: limits, evolution: { ...limits, maxNewRolloutCells: 512, timeoutMs: 14400000 } },
  })
}

export async function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: { project: { type: 'string' }, config: { type: 'string' },
    rounds: { type: 'string', default: '1' }, 'prepare-only': { type: 'boolean' } } })
  if (!v.project || !v.config) throw new Error('--project DIRECTORY and --config BASE_CONFIG_JSON are required (provide actual Meta identity and model configuration)')
  const rounds = Number(v.rounds)
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('rounds must be positive')
  const directory = resolve(v.project), project = await readJson(join(directory, 'project.json'))
  const config = await buildConfig(await readJson(resolve(v.config)), project, directory)
  await requireArtifacts(config)
  // Hitch evaluations spawn from this directory, including after prepare-only.
  await mkdir(config.workspaceRoot, { recursive: true })
  await atomicJson(join(directory, 'gear.config.json'), config)
  if (v['prepare-only']) { process.stdout.write(`${JSON.stringify({ config: join(directory, 'gear.config.json'), objective })}\n`); return }
  const { createSkillControlPlane } = await import('../../lib/skill/control-plane.js')
  const control = await createSkillControlPlane(config)
  try {
    const admitted = await control.gateway.call('control.start', { name: 'Titanic pipeline', rounds, objective })
    await atomicJson(join(directory, 'admission.json'), admitted)
    process.stdout.write(`${JSON.stringify({ socketPath: control.socketPath, admission: admitted, metaIdentity: await control.gateway.call('control.identity', {}) })}\n`)
    // The attached Meta host consumes assignments through the existing Refine Skill.
    await new Promise(accept => { process.once('SIGINT', accept); process.once('SIGTERM', accept) })
  } finally { await control.dispose() }
}
if (isMain(import.meta.url)) cli(main)
