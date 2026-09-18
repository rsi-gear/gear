#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_CODEX_ACCESS_ENV = 'DSH_OPENAI_CODEX_ACCESS_B64'
const CODEX_ACCESS_ENV_PATTERN = /^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/u
const MAX_REQUEST_BYTES = 64 * 1024

function configuredCredentialName(environment = process.env) {
  const name = environment.GEAR_TARGET_CODEX_ENV ?? DEFAULT_CODEX_ACCESS_ENV
  if (!CODEX_ACCESS_ENV_PATTERN.test(name)) {
    throw new Error('GEAR_TARGET_CODEX_ENV must match DSH_OPENAI_CODEX_ACCESS_*_B64')
  }
  return name
}

function exactRequest(value, environment = process.env) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('credential helper request must be an object')
  }
  const request = value
  const keys = Object.keys(request).sort()
  if (keys.join(',') !== 'credentialNames,minimumValidityMs,version') {
    throw new Error('credential helper request fields are invalid')
  }
  if (request.version !== 1) throw new Error('credential helper request version must be 1')
  if (!Number.isSafeInteger(request.minimumValidityMs) || request.minimumValidityMs < 1) {
    throw new Error('credential helper minimumValidityMs must be a positive integer')
  }
  const expectedName = configuredCredentialName(environment)
  if (!Array.isArray(request.credentialNames)
    || request.credentialNames.length !== 1
    || request.credentialNames[0] !== expectedName) {
    throw new Error('credential helper requested an unsupported credential name')
  }
  return { credentialName: expectedName, minimumValidityMs: request.minimumValidityMs }
}

async function findPiAiRoot(moduleUrl) {
  let directory = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = join(directory, 'node_modules', '@earendil-works', 'pi-ai')
    try {
      await readFile(join(candidate, 'package.json'))
      return candidate
    } catch (error) {
      const parent = dirname(directory)
      if (error?.code !== 'ENOENT' || parent === directory) throw error
      directory = parent
    }
  }
}

export async function codexAccessEnvelope(requiredValidityMs, environment = process.env) {
  const authFile = environment.GEAR_TARGET_CODEX_AUTH_FILE
    ?? (environment.DSH_HOME === undefined ? undefined : join(environment.DSH_HOME, '.openai-codex-auth.json'))
  if (authFile === undefined) throw new Error('GEAR_TARGET_CODEX_AUTH_FILE or DSH_HOME is required')

  const moduleName = environment.GEAR_DSH_CODEX_MODULE ?? 'dsh-codex'
  const moduleUrl = moduleName.startsWith('file:') ? moduleName : import.meta.resolve(moduleName)
  const { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } = await import(moduleUrl)
  const piAiRoot = await findPiAiRoot(moduleUrl)
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
      && Number.isSafeInteger(credential.expires)
      && credential.expires > Date.now() + requiredValidityMs) {
      if (environment.GEAR_TARGET_CODEX_EXPECTED_ACCOUNT_ID !== undefined
        && credential.accountId !== environment.GEAR_TARGET_CODEX_EXPECTED_ACCOUNT_ID) {
        throw new Error('OpenAI Codex credential account changed during the evaluation')
      }
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

export async function prepareCredentialResponse(input, environment = process.env) {
  const request = exactRequest(input, environment)
  const envelope = await codexAccessEnvelope(request.minimumValidityMs, environment)
  return {
    version: 1,
    env: {
      [request.credentialName]: Buffer.from(JSON.stringify(envelope)).toString('base64'),
    },
    expiresAtMs: envelope.expires,
  }
}

async function readRequest() {
  process.stdin.setEncoding('utf8')
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new Error('credential helper request is too large')
  }
  const lines = input.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== 1 || lines[0]?.trim().length === 0) {
    throw new Error('credential helper expects one JSON line')
  }
  return JSON.parse(lines[0])
}

async function main() {
  const response = await prepareCredentialResponse(await readRequest())
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('gear-hitch-codex-credential: credential preparation failed\n')
    process.exitCode = 1
  })
}
