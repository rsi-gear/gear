#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exampleRoot = dirname(fileURLToPath(import.meta.url))
const gearRoot = resolve(exampleRoot, '../..')
const labRoot = resolve(process.env.GEAR_LAB_ROOT ?? join(gearRoot, '.evolve-lab'))
const dshHome = resolve(process.env.DSH_HOME ?? join(labRoot, 'dsh-home'))
const runtimeBin = join(labRoot, 'runtime', 'node_modules', '.bin')
const dsh = join(runtimeBin, 'dsh')
const hitch = process.env.GEAR_HITCH_EXECUTABLE ?? join(runtimeBin, 'hitch')
const hitchWrapper = process.env.GEAR_HITCH_CODEX_EXECUTABLE ?? join(gearRoot, 'assets', 'hitch-codex-wrapper.mjs')
const codexModule = pathToFileURL(join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-codex', 'lib', 'index.js')).href
const codex = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-openai-codex')

async function targetMetadata() {
  return JSON.parse(await readFile(join(labRoot, 'target.json'), 'utf8'))
}

async function environment(includeTarget = true) {
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    GEAR_LAB_ROOT: labRoot,
    GEAR_HITCH_EXECUTABLE: hitch,
    GEAR_HITCH_CODEX_EXECUTABLE: hitchWrapper,
    GEAR_RUNTIME_CHECK_EXECUTABLE: process.env.GEAR_RUNTIME_CHECK_EXECUTABLE ?? join(gearRoot, 'assets', 'dsh-runtime-check.mjs'),
    GEAR_DSH_CODEX_MODULE: process.env.GEAR_DSH_CODEX_MODULE ?? codexModule,
    GEAR_META_PROVIDER: process.env.GEAR_META_PROVIDER ?? 'openai-codex',
    GEAR_META_MODEL: process.env.GEAR_META_MODEL ?? 'gpt-5.6-luna',
    GEAR_TARGET_PROVIDER: process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex',
    GEAR_TARGET_MODEL: process.env.GEAR_TARGET_MODEL ?? 'gpt-5.6-luna',
    GEAR_TARGET_CODEX_AUTH_FILE: process.env.GEAR_TARGET_CODEX_AUTH_FILE ?? join(dshHome, '.openai-codex-auth.json'),
    GEAR_TARGET_CODEX_ENV: process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64',
    DSH_CODEX_SEARCH_MODE: process.env.DSH_CODEX_SEARCH_MODE ?? 'live',
  }
  if (!includeTarget) return env
  const target = await targetMetadata()
  return {
    ...env,
    GEAR_TARGET_REPOSITORY: process.env.GEAR_TARGET_REPOSITORY ?? target.targetRepository,
    GEAR_TARGET_DSH_BASE_REF: process.env.GEAR_TARGET_DSH_BASE_REF ?? target.dshBaseRef,
    GEAR_TARGET_INITIAL_CHAMPION_REF: process.env.GEAR_TARGET_INITIAL_CHAMPION_REF ?? target.initialChampion.ref,
    GEAR_TARGET_INITIAL_CHAMPION_DIGEST: process.env.GEAR_TARGET_INITIAL_CHAMPION_DIGEST ?? target.initialChampion.manifestDigest,
    GEAR_TARGET_INITIAL_CHAMPION_UPDATED_AT: process.env.GEAR_TARGET_INITIAL_CHAMPION_UPDATED_AT ?? target.initialChampion.updatedAt,
  }
}

async function run(executable, args, cwd = gearRoot, includeTarget = true) {
  const child = spawn(executable, args, { cwd, env: await environment(includeTarget), stdio: 'inherit' })
  const forward = signal => child.kill(signal)
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveResult({ code, signal }))
  })
  process.removeListener('SIGINT', forward)
  process.removeListener('SIGTERM', forward)
  if (result.signal) process.kill(process.pid, result.signal)
  process.exitCode = result.code ?? 1
}

const command = process.argv[2] ?? 'doctor'
if (command === 'codex-status') {
  await run(codex, ['status'], gearRoot, false)
} else if (command === 'codex-login') {
  await run(codex, ['login'], gearRoot, false)
} else if (command === 'codex-device-login') {
  await run(codex, ['login', '--device-code'], gearRoot, false)
} else if (command === 'doctor') {
  await run(hitchWrapper, ['--root', join(labRoot, 'hitch-home'), 'eval', 'doctor', '--json'])
} else if (command === 'dump') {
  await run(dsh, ['--profile', 'web', '--dump-config'])
} else if (command === 'web') {
  await mkdir(process.env.GEAR_STATE_ROOT ?? join(labRoot, 'state', 'refine'), { recursive: true })
  await mkdir(process.env.GEAR_WORKSPACE_ROOT ?? join(labRoot, 'workspace'), { recursive: true })
  await run(dsh, ['--profile', 'web', '--no-open'], process.env.GEAR_WORKSPACE_ROOT ?? join(labRoot, 'workspace'))
} else if (command === 'prepare') {
  const target = await targetMetadata()
  const ref = `deepseek@git+file://${target.targetRepository}#${target.initialChampion.ref}`
  await run(hitchWrapper, ['--root', join(labRoot, 'hitch-home'), 'prepare', ref, '--json'])
} else if (command === 'target-eval') {
  const dataset = process.argv[3]
  if (!dataset) throw new Error('target-eval requires a dataset path')
  const target = await targetMetadata()
  const ref = `deepseek@git+file://${target.targetRepository}#${target.initialChampion.ref}`
  const provider = process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex'
  const model = process.env.GEAR_TARGET_MODEL ?? 'gpt-5.6-luna'
  const credential = provider === 'openai-codex'
    ? process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
    : 'DEEPSEEK_API_KEY'
  await run(hitchWrapper, [
    '--root', join(labRoot, 'hitch-home'),
    'eval', 'run',
    '--backend', 'harbor',
    '--dataset', resolve(dataset),
    '--harness', ref,
    '--model', `${provider}/${model}`,
    '--attempts', '3',
    '--infrastructure-retries', '0',
    '--max-concurrent', process.env.GEAR_TARGET_MAX_CONCURRENT ?? '12',
    '--timeout', `${process.env.GEAR_TASK_BUDGET_MS ?? '900000'}ms`,
    '--setup-timeout', '1800000ms',
    '--pass-env', credential,
    '--pass-env', 'GEAR_TARGET_CODEX_ENV',
    '--output', 'json',
  ])
} else {
  process.stderr.write('usage: evolve.mjs codex-status|codex-login|codex-device-login|doctor|dump|web|prepare|target-eval <dataset>\n')
  process.exitCode = 2
}
