import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const wrapper = fileURLToPath(new URL('../../assets/hitch-codex-wrapper.mjs', import.meta.url))
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const SHUTDOWN_RESERVE_MS = 5 * 1000
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
  const descendantPidFile = join(root, 'descendant.pid')
  await mkdir(join(piAiDist, 'providers'), { recursive: true })
  await writeFile(hitch, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.argv[2] === '--version') process.stdout.write('0.2.7\\n')
else {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--pass-env' && process.env[args[index + 1]] === undefined) {
      process.stderr.write('environment variable is not set: ' + args[index + 1] + '\\n')
      process.exit(1)
    }
  }
  if (process.env.FAKE_HITCH_IGNORE_TERM === '1') {
    process.on('SIGTERM', () => {})
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: 'ignore',
    })
    writeFileSync(process.env.FAKE_DESCENDANT_PID_FILE, String(descendant.pid))
  }
  const credentialName = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
  const output = () => process.stdout.write(JSON.stringify({ args, credentialName, credential: process.env[credentialName] }))
  if (process.env.FAKE_HITCH_DELAY_MS) setTimeout(output, Number(process.env.FAKE_HITCH_DELAY_MS))
  else output()
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
    exports: {
      '.': './index.js',
      './providers/openai-codex': './provider.js',
    },
  }))
  await writeFile(join(piAiDist, 'index.js'), `
import { appendFile } from 'node:fs/promises'
let swapped = false
export function createModels({ credentials }) {
  return {
    setProvider() {},
    async getAuth(provider, options = {}) {
      let credential = await credentials.read(provider)
      if (Date.now() + (options.minOAuthValidityMs ?? 0) >= credential.expires) {
        credential = await credentials.modify(provider, async current => {
          await appendFile(${JSON.stringify(refreshLog)}, 'refresh\\n')
          return { ...current, access: 'refreshed-access', refresh: 'rotated-host-refresh', expires: Date.now() + 3_600_000 }
        })
      }
      if (Date.now() + (options.minOAuthValidityMs ?? 0) >= credential.expires) {
        throw new Error('refreshed token expires too soon')
      }
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
  return {
    authFile,
    descendantPidFile,
    hitch,
    hitchRoot,
    refreshLog,
    env: {
      ...process.env,
      GEAR_HITCH_EXECUTABLE: hitch,
      GEAR_DSH_CODEX_MODULE: pathToFileURL(plugin).href,
      GEAR_TARGET_CODEX_AUTH_FILE: authFile,
    },
  }
}

function runArgs(root = 'eval') {
  return [
    '--root', root, 'eval', 'run', '--timeout', '10m', '--setup-timeout', '1m',
    '--infrastructure-retries', '0',
    '--pass-env', 'DSH_OPENAI_CODEX_ACCESS_B64', '--pass-env', 'GEAR_TARGET_CODEX_ENV',
  ]
}

function accessEnvelope(stdout: string) {
  const encoded = JSON.parse(stdout).credential
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
}

describe('gear-hitch-codex', () => {
  it('passes non-launch commands through without requiring OAuth', async () => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    const { stdout } = await execute(process.execPath, [wrapper, '--version'], {
      env: { ...process.env, GEAR_HITCH_EXECUTABLE: hitch },
    })
    expect(stdout).toBe('0.2.7\n')
  })

  it('passes explicit non-Codex target evaluations through without requiring OAuth', async () => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    const { stdout } = await execute(process.execPath, [wrapper, 'eval', 'run'], {
      env: {
        ...process.env,
        GEAR_HITCH_EXECUTABLE: hitch,
        GEAR_TARGET_PROVIDER: 'deepseek-official',
      },
    })
    expect(JSON.parse(stdout)).toMatchObject({ args: ['eval', 'run'] })
  })

  it('sets the default credential-name variable required by Hitch pass-env', async () => {
    const fixtureState = await fixture(Date.now() + 86_400_000)
    const env: NodeJS.ProcessEnv = { ...fixtureState.env }
    delete env.GEAR_TARGET_CODEX_ENV
    delete env.DSH_OPENAI_CODEX_ACCESS_B64
    const { stdout } = await execute(process.execPath, [wrapper, ...runArgs()], { env })
    expect(JSON.parse(stdout).credentialName).toBe('DSH_OPENAI_CODEX_ACCESS_B64')
    expect(accessEnvelope(stdout).access).toBe('original-access')
  })

  it('supports a custom credential name in the dedicated namespace', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const credentialName = 'DSH_OPENAI_CODEX_ACCESS_TEAM_A_B64'
    const args = [
      'eval', 'run', '--timeout', '10m', '--setup-timeout', '1m',
      '--pass-env', credentialName, '--pass-env', 'GEAR_TARGET_CODEX_ENV',
    ]
    const { stdout } = await execute(process.execPath, [wrapper, ...args], {
      env: { ...env, GEAR_TARGET_CODEX_ENV: credentialName },
    })
    expect(JSON.parse(stdout).credentialName).toBe(credentialName)
    expect(accessEnvelope(stdout).access).toBe('original-access')
  })

  it('disables the Hitch default infrastructure retry when the option is omitted', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const args = ['eval', 'run', '--timeout', '10m', '--setup-timeout', '1m']
    const { stdout } = await execute(process.execPath, [wrapper, ...args], { env })
    expect(JSON.parse(stdout).args).toEqual([...args, '--infrastructure-retries', '0'])
  })

  it('parses the real command after a --root value named eval and exports access only', async () => {
    const expires = Date.now() + 86_400_000
    const { authFile, env, refreshLog } = await fixture(expires)
    const { stdout } = await execute(process.execPath, [wrapper, ...runArgs()], { env })
    expect(JSON.parse(stdout).args).toEqual(runArgs())
    expect(accessEnvelope(stdout)).toEqual({
      version: 1,
      access: 'original-access',
      expires,
      accountId: 'account-1',
    })
    expect(JSON.parse(await readFile(authFile, 'utf8')).credential.refresh).toBe('host-refresh')
    await expect(readFile(refreshLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes only the host credential for the complete direct-run budget', async () => {
    const { authFile, env, refreshLog } = await fixture(Date.now() + 10 * 60_000)
    const { stdout } = await execute(process.execPath, [wrapper, ...runArgs()], { env })
    expect(accessEnvelope(stdout)).toMatchObject({
      version: 1,
      access: 'refreshed-access',
      accountId: 'account-1',
    })
    expect(accessEnvelope(stdout)).not.toHaveProperty('refresh')
    expect(await readFile(refreshLog, 'utf8')).toBe('refresh\n')
    expect(JSON.parse(await readFile(authFile, 'utf8')).credential.refresh).toBe('rotated-host-refresh')
  })

  it('retries when the credential changes between getAuth and the locked snapshot', async () => {
    const { env } = await fixture(Date.now() + 86_400_000)
    const racedExpires = Date.now() + 3_600_000
    const { stdout } = await execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, FAKE_SWAP_AFTER_GET_AUTH: '1', FAKE_RACED_EXPIRES: String(racedExpires) },
    })
    expect(accessEnvelope(stdout)).toMatchObject({
      access: 'raced-access',
      expires: racedExpires,
      accountId: 'account-2',
    })
  })

  it('supports a direct rerun using the frozen request budgets', async () => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    const evalId = 'eval_1234567890abcdef1234567890abcdef'
    const evalRoot = join(hitchRoot, 'evals', evalId)
    await mkdir(evalRoot, { recursive: true })
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({
      timeout_ms: 600_000,
      setup_timeout_ms: 60_000,
      attempts: 1,
      infrastructure_retries: 0,
    }))
    const args = ['--root', hitchRoot, 'eval', 'rerun', evalId, '--task', 'one']
    const { stdout } = await execute(process.execPath, [wrapper, ...args], { env })
    expect(JSON.parse(stdout).args).toEqual(args)
    expect(accessEnvelope(stdout).access).toBe('original-access')
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
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({ timeout_ms: 600_000 }))
    await writeFile(join(evalRoot, 'submission.json'), '{}')
    await expect(execute(process.execPath, [
      wrapper, '--root', hitchRoot, 'eval', 'rerun', evalId, '--task', 'one',
    ], { env })).rejects.toMatchObject({ stderr: expect.stringContaining('daemon rerun is unsupported') })
  })

  it.each([
    ['run', ['eval', 'run', '--timeout', '10m', '--setup-timeout', '0']],
    ['rerun', undefined],
  ])('rejects an unlimited setup timeout for direct %s', async (action, args) => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    let invocationArgs = args
    if (action === 'rerun') {
      const evalId = 'eval_1234567890abcdef1234567890abcdef'
      const evalRoot = join(hitchRoot, 'evals', evalId)
      await mkdir(evalRoot, { recursive: true })
      await writeFile(join(evalRoot, 'request.json'), JSON.stringify({
        timeout_ms: 600_000,
        setup_timeout_ms: 0,
        attempts: 1,
        infrastructure_retries: 0,
      }))
      invocationArgs = ['--root', hitchRoot, 'eval', 'rerun', evalId]
    }
    await expect(execute(process.execPath, [wrapper, ...(invocationArgs ?? [])], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('positive --setup-timeout') })
  })

  it.each([
    ['multiple attempts', ['eval', 'run', '--timeout', '10m', '--setup-timeout', '1m', '--attempts', '2']],
    ['an infrastructure retry', [
      'eval', 'run', '--timeout', '10m', '--setup-timeout', '1m', '--infrastructure-retries', '1',
    ]],
  ])('rejects direct runs with %s', async (_name, args) => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...args], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('one attempt and zero infrastructure retries') })
  })

  it.each([
    ['multiple attempts', { attempts: 2, infrastructure_retries: 0 }],
    ['an infrastructure retry', { attempts: 1, infrastructure_retries: 1 }],
  ])('rejects direct reruns with %s', async (_name, request) => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    const evalId = 'eval_1234567890abcdef1234567890abcdef'
    const evalRoot = join(hitchRoot, 'evals', evalId)
    await mkdir(evalRoot, { recursive: true })
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({
      timeout_ms: 600_000,
      setup_timeout_ms: 60_000,
      ...request,
    }))
    await expect(execute(process.execPath, [wrapper, '--root', hitchRoot, 'eval', 'rerun', evalId], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('one attempt and zero infrastructure retries') })
  })

  it.each(['PATH', 'GEAR_TARGET_CODEX_ENV'])('rejects unsafe credential environment name %s', async name => {
    const { env } = await fixture(Date.now() + 86_400_000)
    await expect(execute(process.execPath, [wrapper, ...runArgs()], {
      env: { ...env, GEAR_TARGET_CODEX_ENV: name },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('DSH_OPENAI_CODEX_ACCESS_*_B64') })
  })

  it('force-kills an uncooperative Hitch process tree before the access refresh window', async () => {
    const expires = Date.now() + EXPIRY_MARGIN_MS + SHUTDOWN_RESERVE_MS + 750
    const { descendantPidFile, env } = await fixture(expires)
    await expect(execute(process.execPath, [wrapper,
      'eval', 'run', '--timeout', '1ms', '--setup-timeout', '1ms', '--infrastructure-retries', '0',
    ], { env: {
      ...env,
      FAKE_DESCENDANT_PID_FILE: descendantPidFile,
      FAKE_HITCH_DELAY_MS: '10000',
      FAKE_HITCH_IGNORE_TERM: '1',
    } }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('target access safety deadline') })
    expect(Date.now()).toBeLessThan(expires - EXPIRY_MARGIN_MS)
    const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))
    expect(() => process.kill(descendantPid, 0)).toThrow()
  })
})
