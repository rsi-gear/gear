import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const wrapper = fileURLToPath(new URL('../../assets/hitch-codex-wrapper.mjs', import.meta.url))
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
if (process.argv[2] === '--version') process.stdout.write('0.2.7\\n')
else process.stdout.write(JSON.stringify({ args: process.argv.slice(2), credential: process.env.DSH_OPENAI_CODEX_ACCESS_B64 }))
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
      return { auth: { apiKey: credential.access } }
    },
  }
}
`)
  await writeFile(join(piAiDist, 'providers', 'openai-codex.js'), `
export function openaiCodexProvider() { return { id: 'openai-codex' } }
`)
  return {
    authFile,
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
  return ['--root', root, 'eval', 'run', '--timeout', '10m', '--setup-timeout', '1m']
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
    expect(JSON.parse(stdout)).toEqual({ args: ['eval', 'run'] })
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

  it('supports a direct rerun using the frozen request budgets', async () => {
    const { env, hitchRoot } = await fixture(Date.now() + 86_400_000)
    const evalId = 'eval_1234567890abcdef1234567890abcdef'
    const evalRoot = join(hitchRoot, 'evals', evalId)
    await mkdir(evalRoot, { recursive: true })
    await writeFile(join(evalRoot, 'request.json'), JSON.stringify({ timeout_ms: 600_000, setup_timeout_ms: 60_000 }))
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
})
