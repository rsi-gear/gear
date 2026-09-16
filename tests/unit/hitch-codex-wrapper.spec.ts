import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const wrapper = fileURLToPath(new URL('../../assets/hitch-codex-wrapper.mjs', import.meta.url))
const helper = fileURLToPath(new URL('../../assets/hitch-codex-credential-helper.mjs', import.meta.url))
const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function fixture(expires: number) {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-codex-'))
  roots.push(root)
  const hitch = join(root, 'hitch.mjs')
  const hitchRoot = join(root, 'hitch-root')
  const authFile = join(root, 'auth.json')
  const plugin = join(root, 'dsh-codex.mjs')
  const piAiRoot = join(root, 'node_modules', '@earendil-works', 'pi-ai')
  const piAiDist = join(piAiRoot, 'dist')
  const refreshLog = join(root, 'refresh.log')
  await mkdir(join(piAiDist, 'providers'), { recursive: true })
  await writeFile(hitch, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const evalIndex = args.indexOf('eval')
const action = evalIndex < 0 ? undefined : args[evalIndex + 1]
if (process.argv[2] === '--version') process.stdout.write('0.2.9\\n')
else if (action === 'doctor') {
  process.stdout.write(JSON.stringify({
    ready: process.env.FAKE_HITCH_NOT_READY !== '1',
    capabilities: process.env.FAKE_HITCH_NO_CAPABILITY === '1' ? [] : ['host-task-credential-helper-v1'],
  }))
} else {
  const configured = process.env.HITCH_HOST_CREDENTIAL_HELPER_JSON
  const helperConfig = configured === undefined ? undefined : JSON.parse(configured)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--pass-env' && process.env[args[index + 1]] === undefined
      && !helperConfig?.credentialNames.includes(args[index + 1])) {
      process.stderr.write('environment variable is not set: ' + args[index + 1] + '\\n')
      process.exit(1)
    }
  }
  const credentialName = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
  const responses = []
  if (configured !== undefined) {
    const config = helperConfig
    if (process.env.FAKE_HITCH_SWAP_ACCOUNT_BEFORE_HELPER === '1') {
      const { readFileSync, writeFileSync } = await import('node:fs')
      const filename = process.env.GEAR_TARGET_CODEX_AUTH_FILE
      const stored = JSON.parse(readFileSync(filename, 'utf8'))
      stored.credential = { ...stored.credential, access: 'other-account-access', accountId: 'account-2' }
      writeFileSync(filename, JSON.stringify(stored) + '\\n')
    }
    const validity = JSON.parse(process.env.FAKE_HELPER_VALIDITY_MS ?? '[60000]')
    for (const minimumValidityMs of validity) {
      const result = spawnSync(config.argv[0], config.argv.slice(1), {
        encoding: 'utf8',
        env: process.env,
        input: JSON.stringify({ version: 1, credentialNames: config.credentialNames, minimumValidityMs }) + '\\n',
      })
      if (result.status !== 0) {
        process.stderr.write('host_credential_helper_failed\\n')
        process.exit(1)
      }
      responses.push(JSON.parse(result.stdout))
    }
  }
  process.stdout.write(JSON.stringify({
    args,
    credentialName,
    evalWideCredential: process.env[credentialName],
    helperConfig: configured === undefined ? undefined : JSON.parse(configured),
    responses,
  }))
}
`)
  await chmod(hitch, 0o755)
  await writeFile(authFile, `${JSON.stringify({
    version: 1,
    credential: {
      type: 'oauth',
      access: 'original-access',
      refresh: 'host-refresh',
      expires,
      accountId: 'account-1',
    },
  })}\n`)
  await writeFile(plugin, `
import { readFile, writeFile } from 'node:fs/promises'
export const OPENAI_CODEX_PROVIDER = 'openai-codex'
export class OpenAICodexCredentialStore {
  constructor(filename) { this.filename = filename }
  async read() { return JSON.parse(await readFile(this.filename, 'utf8')).credential }
  async modify(provider, fn) {
    const current = await this.read(provider)
    const candidate = await fn(current)
    if (candidate !== undefined) {
      await writeFile(this.filename, JSON.stringify({ version: 1, credential: candidate }) + '\\n')
      return candidate
    }
    return current
  }
}
`)
  await writeFile(join(piAiRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '0.84.4',
    type: 'module',
    exports: { '.': './index.js', './providers/openai-codex': './provider.js' },
  }))
  await writeFile(join(piAiDist, 'index.js'), `
import { appendFile } from 'node:fs/promises'
let swapped = false
export function createModels({ credentials }) {
  return {
    setProvider() {},
    async getAuth(provider, options = {}) {
      let credential = await credentials.read(provider)
      if (process.env.FAKE_AUTH_THROW_SECRET !== undefined) throw new Error(process.env.FAKE_AUTH_THROW_SECRET)
      if (Date.now() + (options.minOAuthValidityMs ?? 0) >= credential.expires) {
        credential = await credentials.modify(provider, async current => {
          await appendFile(${JSON.stringify(refreshLog)}, 'refresh\\n')
          return { ...current, access: 'refreshed-access', refresh: 'rotated-host-refresh', expires: Date.now() + 3_600_000 }
        })
      }
      if (Date.now() + (options.minOAuthValidityMs ?? 0) >= credential.expires) throw new Error('refreshed token expires too soon')
      const auth = { auth: { apiKey: credential.access } }
      if (process.env.FAKE_SWAP_AFTER_GET_AUTH === '1' && !swapped) {
        swapped = true
        await credentials.modify(provider, async current => ({
          ...current,
          access: 'raced-access',
          refresh: 'raced-host-refresh',
          expires: Number(process.env.FAKE_RACED_EXPIRES),
          accountId: 'account-2',
        }))
      }
      return auth
    },
  }
}
`)
  await writeFile(join(piAiDist, 'providers', 'openai-codex.js'), `
export function openaiCodexProvider() { return { id: 'openai-codex' } }
`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEAR_HITCH_EXECUTABLE: hitch,
    GEAR_DSH_CODEX_MODULE: pathToFileURL(plugin).href,
    GEAR_TARGET_CODEX_AUTH_FILE: authFile,
    GEAR_TARGET_CODEX_ENV: 'DSH_OPENAI_CODEX_ACCESS_B64',
  }
  delete env.DSH_OPENAI_CODEX_ACCESS_B64
  return {
    authFile,
    hitch,
    hitchRoot,
    refreshLog,
    env,
  }
}

function runArgs(root = 'eval', credentialName = 'DSH_OPENAI_CODEX_ACCESS_B64') {
  return [
    '--root', root, 'eval', 'run', '--timeout', '10m', '--setup-timeout', '1m',
    '--attempts', '3', '--infrastructure-retries', '0',
    '--pass-env', credentialName, '--pass-env', 'GEAR_TARGET_CODEX_ENV',
  ]
}

function response(stdout: string) {
  return JSON.parse(stdout) as {
    args: string[]
    credentialName: string
    evalWideCredential?: string
    helperConfig?: { version: number; argv: string[]; credentialNames: string[]; timeoutMs: number }
    responses: Array<{ version: number; env: Record<string, string>; expiresAtMs: number }>
  }
}

function accessEnvelope(output: ReturnType<typeof response>, index = 0) {
  const encoded = output.responses[index]?.env[output.credentialName]
  if (encoded === undefined) throw new Error('fixture did not receive a credential')
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    version: number; access: string; expires: number; accountId: string; refresh?: string
  }
}

async function executeHelper(input: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [helper], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(input)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { code, stdout, stderr }
}

describe('gear-hitch-codex', () => {
  it('passes non-launch commands through without requiring OAuth', async () => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    const { stdout } = await execute(process.execPath, [wrapper, '--version'], {
      env: { ...process.env, GEAR_HITCH_EXECUTABLE: hitch },
    })
    expect(stdout).toBe('0.2.9\n')
  })

  it('passes explicit non-Codex target evaluations through without a helper', async () => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    const { stdout } = await execute(process.execPath, [wrapper, 'eval', 'run'], {
      env: { ...process.env, GEAR_HITCH_EXECUTABLE: hitch, GEAR_TARGET_PROVIDER: 'deepseek-official' },
    })
    expect(response(stdout)).toMatchObject({ args: ['eval', 'run'], responses: [] })
  })

  it('configures the packaged host helper without exporting access for the whole eval', async () => {
    const expires = Date.now() + 86_400_000
    const { authFile, env, refreshLog } = await fixture(expires)
    const output = response((await execute(process.execPath, [wrapper, ...runArgs()], { env })).stdout)
    expect(output.args).toEqual(runArgs())
    expect(output.evalWideCredential).toBeUndefined()
    expect(output.helperConfig).toMatchObject({
      version: 1,
      argv: [process.execPath, helper],
      credentialNames: ['DSH_OPENAI_CODEX_ACCESS_B64'],
      timeoutMs: 60_000,
    })
    expect(output.helperConfig?.argv.every(value => value.startsWith('/'))).toBe(true)
    expect(JSON.stringify(output.helperConfig)).not.toMatch(/original-access|host-refresh|auth\.json/u)
    expect(accessEnvelope(output)).toEqual({
      version: 1, access: 'original-access', expires, accountId: 'account-1',
    })
    expect(output.responses[0]?.expiresAtMs).toBe(expires)
    expect(JSON.parse(await readFile(authFile, 'utf8')).credential.refresh).toBe('host-refresh')
    await expect(readFile(refreshLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gets credentials independently for later tasks and uses the refreshed host snapshot', async () => {
    const { authFile, env, refreshLog } = await fixture(Date.now() + 10 * 60_000)
    const output = response((await execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, FAKE_HELPER_VALIDITY_MS: JSON.stringify([60_000, 30 * 60_000]) },
    })).stdout)
    expect(output.responses).toHaveLength(2)
    expect(accessEnvelope(output, 0).access).toBe('original-access')
    expect(accessEnvelope(output, 1)).toMatchObject({ access: 'refreshed-access', accountId: 'account-1' })
    expect(accessEnvelope(output, 1)).not.toHaveProperty('refresh')
    expect(await readFile(refreshLog, 'utf8')).toBe('refresh\n')
    expect(JSON.parse(await readFile(authFile, 'utf8')).credential.refresh).toBe('rotated-host-refresh')
  })

  it('fails explicitly when a refreshed credential cannot cover the requested task budget', async () => {
    const { env } = await fixture(Date.now() + 10 * 60_000)
    let stderr = ''
    try {
      await execute(process.execPath, [wrapper, ...runArgs()], {
        env: { ...env, FAKE_HELPER_VALIDITY_MS: JSON.stringify([2 * 3_600_000]) },
      })
    } catch (error) {
      stderr = (error as { stderr: string }).stderr
    }
    expect(stderr).toContain('host_credential_helper_failed')
    expect(stderr).not.toMatch(/refreshed-access|rotated-host-refresh|expires too soon/u)
  })

  it('supports a custom dedicated credential name', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const credentialName = 'DSH_OPENAI_CODEX_ACCESS_TEAM_A_B64'
    const output = response((await execute(process.execPath, [wrapper, ...runArgs('eval', credentialName)], {
      env: { ...env, GEAR_TARGET_CODEX_ENV: credentialName },
    })).stdout)
    expect(output.helperConfig?.credentialNames).toEqual([credentialName])
    expect(accessEnvelope(output).access).toBe('original-access')
  })

  it('allows native multiple attempts and keeps the explicit zero retry policy', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const output = response((await execute(process.execPath, [wrapper, ...runArgs()], { env })).stdout)
    expect(output.args).toContain('3')
    expect(output.args.slice(-6)).toEqual([
      '--infrastructure-retries', '0', '--pass-env', 'DSH_OPENAI_CODEX_ACCESS_B64',
      '--pass-env', 'GEAR_TARGET_CODEX_ENV',
    ])
  })

  it('disables the Hitch default infrastructure retry when the option is omitted', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const args = ['eval', 'run', '--timeout', '10m', '--attempts', '3']
    const output = response((await execute(process.execPath, [wrapper, ...args], { env })).stdout)
    expect(output.args).toEqual([...args, '--infrastructure-retries', '0'])
  })

  it('supports a direct rerun whose frozen request has multiple attempts', async () => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    const evalId = 'eval_1234567890abcdef1234567890abcdef'
    const evalRoot = join(hitchRoot, 'evals', evalId)
    await mkdir(evalRoot, { recursive: true })
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({ attempts: 3, infrastructure_retries: 0 }))
    const args = ['--root', hitchRoot, 'eval', 'rerun', evalId, '--task', 'one']
    const output = response((await execute(process.execPath, [wrapper, ...args], { env })).stdout)
    expect(output.args).toEqual(args)
    expect(accessEnvelope(output).access).toBe('original-access')
  })

  it('fails closed before launch when Hitch lacks the task credential capability', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, FAKE_HITCH_NO_CAPABILITY: '1' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('host-task-credential-helper-v1') })
  })

  it('fails closed before launch when Hitch doctor is not ready', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, FAKE_HITCH_NOT_READY: '1' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('preflight is not ready') })
  })

  it('does not expose a credential-library error from host preflight', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const marker = 'raw-library-error-including-secret-marker'
    let stderr = ''
    try {
      await execute(process.execPath, [wrapper, ...runArgs()], {
        env: { ...env, FAKE_AUTH_THROW_SECRET: marker },
      })
    } catch (error) {
      stderr = (error as { stderr: string }).stderr
    }
    expect(stderr).toContain('OpenAI Codex host credential preflight failed')
    expect(stderr).not.toContain(marker)
  })

  it('fails a later task when the host login changes accounts after preflight', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    let stderr = ''
    try {
      await execute(process.execPath, [wrapper, ...runArgs()], {
        env: { ...env, FAKE_HITCH_SWAP_ACCOUNT_BEFORE_HELPER: '1' },
      })
    } catch (error) {
      stderr = (error as { stderr: string }).stderr
    }
    expect(stderr).toContain('host_credential_helper_failed')
    expect(stderr).not.toMatch(/other-account-access|account-2/u)
  })

  it.each([
    ['eval submit', ['eval', 'submit', '--timeout', '10m']],
    ['eval run --daemon', ['eval', 'run', '--daemon', '--timeout', '10m']],
  ])('rejects daemon path %s before reading OAuth', async (_name, args) => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...args], {
      env: { ...process.env, GEAR_HITCH_EXECUTABLE: hitch },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('daemon submission is unsupported') })
  })

  it('rejects implicit daemon reruns recorded by Hitch', async () => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    const evalId = 'eval_1234567890abcdef1234567890abcdef'
    const evalRoot = join(hitchRoot, 'evals', evalId)
    await mkdir(evalRoot, { recursive: true })
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({ attempts: 3, infrastructure_retries: 0 }))
    await writeFile(join(evalRoot, 'submission.json'), '{}')
    await expect(execute(process.execPath, [wrapper, '--root', hitchRoot, 'eval', 'rerun', evalId], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('daemon rerun is unsupported') })
  })

  it('rejects infrastructure retries without restricting attempts', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, 'eval', 'run', '--attempts', '3', '--infrastructure-retries', '1'], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('zero infrastructure retries') })
  })

  it('rejects a whole-eval credential value while allowing its declarative pass-env name', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, DSH_OPENAI_CODEX_ACCESS_B64: 'must-not-reach-hitch' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to expose') })
  })

  it.each(['PATH', 'GEAR_TARGET_CODEX_ENV'])('rejects unsafe credential environment name %s', async name => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, GEAR_TARGET_CODEX_ENV: name },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('DSH_OPENAI_CODEX_ACCESS_*_B64') })
  })

  it('rejects helper requests for any credential outside the configured name', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const result = await executeHelper(
      `${JSON.stringify({ version: 1, credentialNames: ['PATH'], minimumValidityMs: 1 })}\n`, env,
    )
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'gear-hitch-codex-credential: credential preparation failed\n',
    })
  })

  it('does not depend on host process-table inspection', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const output = response((await execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, PATH: dirname(process.execPath) },
    })).stdout)
    expect(accessEnvelope(output).access).toBe('original-access')
  })
})
