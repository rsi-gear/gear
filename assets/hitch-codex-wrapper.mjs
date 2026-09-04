#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REFRESH_WINDOW_MS = 5 * 60 * 1000
const CODEX_CREDENTIAL_ENV = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_AUTH_B64'

function launchesTrials(args) {
  const evalIndex = args.indexOf('eval')
  return evalIndex >= 0 && ['run', 'submit', 'rerun'].includes(args[evalIndex + 1])
}

async function targetEnvironment(args) {
  if (!launchesTrials(args) || (process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex') !== 'openai-codex') {
    return process.env
  }
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(CODEX_CREDENTIAL_ENV)) {
    throw new Error('GEAR_TARGET_CODEX_ENV must be an environment variable name')
  }
  const authFile = process.env.GEAR_TARGET_CODEX_AUTH_FILE
    ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, '.openai-codex-auth.json'))
  if (authFile === undefined) throw new Error('GEAR_TARGET_CODEX_AUTH_FILE or DSH_HOME is required')

  const moduleName = process.env.GEAR_DSH_CODEX_MODULE ?? 'dsh-codex'
  const {
    OpenAICodexCredentialStore,
    openAICodexAuthStatus,
    readOpenAICodexRateLimits,
  } = await import(moduleName)
  const store = new OpenAICodexCredentialStore(authFile)
  const status = await openAICodexAuthStatus(store)
  if (!status.authenticated) throw new Error('OpenAI Codex is signed out')
  const expiresAt = status.expiresAt?.valueOf()
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + REFRESH_WINDOW_MS) {
    await readOpenAICodexRateLimits(store)
  }
  return {
    ...process.env,
    [CODEX_CREDENTIAL_ENV]: (await readFile(authFile)).toString('base64'),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const child = spawn(process.env.GEAR_HITCH_EXECUTABLE ?? 'hitch', args, {
    env: await targetEnvironment(args),
    stdio: 'inherit',
  })
  const forward = signal => child.kill(signal)
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  process.removeListener('SIGINT', forward)
  process.removeListener('SIGTERM', forward)
  if (result.signal !== null) process.kill(process.pid, result.signal)
  process.exitCode = result.code ?? 1
}

main().catch(error => {
  process.stderr.write(`gear-hitch-codex: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
