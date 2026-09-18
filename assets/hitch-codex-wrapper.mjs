#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { codexAccessEnvelope } from './hitch-codex-credential-helper.mjs'

const CODEX_ACCESS_ENV = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
const CREDENTIAL_CAPABILITY = 'host-task-credential-helper-v1'
const CREDENTIAL_HELPER_ENV = 'HITCH_HOST_CREDENTIAL_HELPER_JSON'
const CREDENTIAL_HELPER_TIMEOUT_MS = 60_000
const execute = promisify(execFile)
const credentialHelper = fileURLToPath(new URL('./hitch-codex-credential-helper.mjs', import.meta.url))

function takeOption(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (index === args.length - 1) throw new Error(`${name} requires a value`)
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}

function invocation(args) {
  const remaining = [...args]
  const root = resolve(takeOption(remaining, '--root') ?? process.env.HITCH_ROOT ?? join(homedir(), '.hitch'))
  return {
    root,
    command: remaining[0],
    action: remaining[1],
    actionArgs: remaining.slice(2),
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function safeCodexArgs(args) {
  if ((process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex') !== 'openai-codex') return args
  const parsed = invocation(args)
  if (parsed.command === 'eval' && parsed.action === 'run'
    && option(parsed.actionArgs, '--infrastructure-retries') === undefined) {
    return [...args, '--infrastructure-retries', '0']
  }
  return args
}

async function directCodexEvaluation(args) {
  const parsed = invocation(args)
  if (parsed.command !== 'eval' || !['run', 'submit', 'rerun'].includes(parsed.action)) return false
  if (!/^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/u.test(CODEX_ACCESS_ENV)) {
    throw new Error('GEAR_TARGET_CODEX_ENV must match DSH_OPENAI_CODEX_ACCESS_*_B64')
  }
  if (parsed.action === 'submit' || parsed.actionArgs.includes('--daemon')) {
    throw new Error('Codex target credentials require direct Hitch evals; daemon submission is unsupported')
  }

  let infrastructureRetries
  if (parsed.action === 'run') {
    infrastructureRetries = option(parsed.actionArgs, '--infrastructure-retries') ?? 1
  } else {
    const evalId = parsed.actionArgs[0]
    if (!/^eval_[a-f0-9]{32}$/u.test(evalId ?? '')) throw new Error('eval rerun requires a valid eval ID')
    try {
      await readFile(join(parsed.root, 'evals', evalId, 'submission.json'))
      throw new Error('Codex target credentials require direct Hitch evals; daemon rerun is unsupported')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const request = JSON.parse(await readFile(join(parsed.root, 'evals', evalId, 'request.json'), 'utf8'))
    infrastructureRetries = request.infrastructure_retries ?? 1
  }
  if (Number(infrastructureRetries) !== 0) {
    throw new Error('Codex target direct evals require zero infrastructure retries')
  }
  if (parsed.actionArgs.some((value, index) => parsed.actionArgs[index - 1] === '--pass-env'
    && value === CODEX_ACCESS_ENV)
    && typeof process.env[CODEX_ACCESS_ENV] === 'string'
    && process.env[CODEX_ACCESS_ENV].length > 0) {
    throw new Error('refusing to expose a Codex access value across the whole Hitch eval')
  }
  return true
}

function credentialEnvironment(environment = process.env) {
  if (!/^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/u.test(CODEX_ACCESS_ENV)) {
    throw new Error('GEAR_TARGET_CODEX_ENV must match DSH_OPENAI_CODEX_ACCESS_*_B64')
  }
  return {
    ...environment,
    [CREDENTIAL_HELPER_ENV]: JSON.stringify({
      version: 1,
      argv: [process.execPath, credentialHelper],
      credentialNames: [CODEX_ACCESS_ENV],
      timeoutMs: CREDENTIAL_HELPER_TIMEOUT_MS,
    }),
  }
}

async function requireCredentialCapability(parsed) {
  const args = ['--root', parsed.root, 'eval', 'doctor', '--json']
  const environment = { ...process.env }
  delete environment[CREDENTIAL_HELPER_ENV]
  let doctor
  try {
    const { stdout } = await execute(process.env.GEAR_HITCH_EXECUTABLE ?? 'hitch', args, {
      env: environment,
      maxBuffer: 1024 * 1024,
    })
    doctor = JSON.parse(stdout)
  } catch {
    throw new Error('Hitch credential capability preflight failed')
  }
  if (doctor.ready !== true) throw new Error('Hitch credential capability preflight is not ready')
  if (!Array.isArray(doctor.capabilities) || !doctor.capabilities.includes(CREDENTIAL_CAPABILITY)) {
    throw new Error(`Hitch does not advertise required capability ${CREDENTIAL_CAPABILITY}`)
  }
}

async function main() {
  const args = safeCodexArgs(process.argv.slice(2))
  let environment = { ...process.env, GEAR_TARGET_CODEX_ENV: CODEX_ACCESS_ENV }
  if ((process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex') === 'openai-codex'
    && await directCodexEvaluation(args)) {
    const parsed = invocation(args)
    await requireCredentialCapability(parsed)
    // Check the host login without pinning its access token to the whole eval.
    let accountId
    try {
      accountId = (await codexAccessEnvelope(0)).accountId
    } catch {
      throw new Error('OpenAI Codex host credential preflight failed')
    }
    environment = credentialEnvironment({
      ...environment,
      GEAR_TARGET_CODEX_EXPECTED_ACCOUNT_ID: accountId,
    })
  }
  const child = spawn(process.env.GEAR_HITCH_EXECUTABLE ?? 'hitch', args, {
    env: environment,
    stdio: 'inherit',
  })
  const forwardInterrupt = () => child.kill('SIGINT')
  const forwardTerminate = () => child.kill('SIGTERM')
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveResult({ code, signal }))
  })
  process.removeListener('SIGINT', forwardInterrupt)
  process.removeListener('SIGTERM', forwardTerminate)
  if (result.signal !== null) process.kill(process.pid, result.signal)
  process.exitCode = result.code ?? 1
}

main().catch(error => {
  process.stderr.write(`gear-hitch-codex: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
