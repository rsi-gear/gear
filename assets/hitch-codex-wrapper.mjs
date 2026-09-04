#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_SETUP_BUDGET_MS = 30 * 60 * 1000
const CODEX_ACCESS_ENV = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'

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

function duration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u)
  if (!match) throw new Error(`invalid duration: ${value}`)
  const scales = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
  return Math.round(Number(match[1]) * scales[match[2] ?? 'ms'])
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

async function trialValidity(args) {
  const parsed = invocation(args)
  if (parsed.command !== 'eval' || !['run', 'submit', 'rerun'].includes(parsed.action)) return undefined
  if (parsed.action === 'submit' || parsed.actionArgs.includes('--daemon')) {
    throw new Error('Codex target credentials require direct Hitch evals; daemon submission is unsupported')
  }

  let timeout
  let setupTimeout
  let attempts
  let infrastructureRetries
  if (parsed.action === 'run') {
    timeout = option(parsed.actionArgs, '--timeout')
    setupTimeout = option(parsed.actionArgs, '--setup-timeout')
    attempts = option(parsed.actionArgs, '--attempts') ?? 1
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
    timeout = request.timeout_ms
    setupTimeout = request.setup_timeout_ms
    attempts = request.attempts ?? 1
    infrastructureRetries = request.infrastructure_retries ?? 1
  }
  if (Number(attempts) !== 1 || Number(infrastructureRetries) !== 0) {
    throw new Error('Codex target direct evals require one attempt and zero infrastructure retries')
  }
  if (timeout === undefined || duration(timeout) <= 0) {
    throw new Error('Codex target direct evals require a positive --timeout')
  }
  const setupBudgetMs = duration(setupTimeout ?? DEFAULT_SETUP_BUDGET_MS)
  if (setupBudgetMs <= 0) {
    throw new Error('Codex target direct evals require a positive --setup-timeout')
  }
  return duration(timeout) + setupBudgetMs + EXPIRY_MARGIN_MS
}

async function codexAccessEnvelope(requiredValidityMs) {
  if (!/^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/u.test(CODEX_ACCESS_ENV)) {
    throw new Error('GEAR_TARGET_CODEX_ENV must match DSH_OPENAI_CODEX_ACCESS_*_B64')
  }
  const authFile = process.env.GEAR_TARGET_CODEX_AUTH_FILE
    ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, '.openai-codex-auth.json'))
  if (authFile === undefined) throw new Error('GEAR_TARGET_CODEX_AUTH_FILE or DSH_HOME is required')

  const moduleName = process.env.GEAR_DSH_CODEX_MODULE ?? 'dsh-codex'
  const moduleUrl = moduleName.startsWith('file:') ? moduleName : import.meta.resolve(moduleName)
  const { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } = await import(moduleUrl)
  let directory = dirname(fileURLToPath(moduleUrl))
  let piAiRoot
  for (;;) {
    const candidate = join(directory, 'node_modules', '@earendil-works', 'pi-ai')
    try {
      await readFile(join(candidate, 'package.json'))
      piAiRoot = candidate
      break
    } catch (error) {
      const parent = dirname(directory)
      if (error?.code !== 'ENOENT' || parent === directory) throw error
      directory = parent
    }
  }
  const { createModels } = await import(pathToFileURL(join(piAiRoot, 'dist', 'index.js')).href)
  const { openaiCodexProvider } = await import(pathToFileURL(join(piAiRoot, 'dist', 'providers', 'openai-codex.js')).href)
  const store = new OpenAICodexCredentialStore(authFile)
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const auth = await models.getAuth(OPENAI_CODEX_PROVIDER, { minOAuthValidityMs: requiredValidityMs })
    const credential = await store.modify(OPENAI_CODEX_PROVIDER, async () => undefined)
    const access = auth?.auth.apiKey
    if (credential?.type === 'oauth' && typeof credential.accountId === 'string'
      && typeof access === 'string' && access.length > 0 && credential.access === access
      && credential.expires > Date.now() + requiredValidityMs) {
      return {
        version: 1,
        access,
        expires: credential.expires,
        accountId: credential.accountId,
      }
    }
  }
  throw new Error('OpenAI Codex credential changed while exporting target access')
}

async function targetEnvironment(args) {
  const environment = { ...process.env, GEAR_TARGET_CODEX_ENV: CODEX_ACCESS_ENV }
  if ((process.env.GEAR_TARGET_PROVIDER ?? 'openai-codex') !== 'openai-codex') return { environment }
  const requiredValidityMs = await trialValidity(args)
  if (requiredValidityMs === undefined) return { environment }
  const envelope = await codexAccessEnvelope(requiredValidityMs)
  return {
    environment: {
      ...environment,
      [CODEX_ACCESS_ENV]: Buffer.from(JSON.stringify(envelope)).toString('base64'),
    },
    accessDeadlineAt: envelope.expires - EXPIRY_MARGIN_MS,
  }
}

async function main() {
  const args = safeCodexArgs(process.argv.slice(2))
  const target = await targetEnvironment(args)
  const child = spawn(process.env.GEAR_HITCH_EXECUTABLE ?? 'hitch', args, {
    env: target.environment,
    stdio: 'inherit',
  })
  let accessDeadlineReached = false
  const deadlineTimer = target.accessDeadlineAt === undefined ? undefined : setTimeout(() => {
    accessDeadlineReached = child.kill('SIGTERM')
  }, Math.max(0, target.accessDeadlineAt - Date.now()))
  const forward = signal => child.kill(signal)
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  let result
  try {
    result = await new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveResult({ code, signal }))
    })
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  }
  process.removeListener('SIGINT', forward)
  process.removeListener('SIGTERM', forward)
  if (accessDeadlineReached) {
    process.stderr.write('gear-hitch-codex: target access safety deadline reached before Hitch completed\n')
    process.exitCode = 1
    return
  }
  if (result.signal !== null) process.kill(process.pid, result.signal)
  process.exitCode = result.code ?? 1
}

main().catch(error => {
  process.stderr.write(`gear-hitch-codex: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
