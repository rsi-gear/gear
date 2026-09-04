import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const authFile = join(root, 'auth.json')
  const plugin = join(root, 'dsh-codex.mjs')
  const refreshLog = join(root, 'refresh.log')
  await writeFile(hitch, `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('0.2.6\\n')
else process.stdout.write(JSON.stringify({ args: process.argv.slice(2), credential: process.env.DSH_OPENAI_CODEX_AUTH_B64 }))
`)
  await chmod(hitch, 0o755)
  await writeFile(authFile, `${JSON.stringify({ value: 'original', expires })}\n`)
  await writeFile(plugin, `
import { appendFile, readFile, writeFile } from 'node:fs/promises'
export class OpenAICodexCredentialStore { constructor(filename) { this.filename = filename } }
export async function openAICodexAuthStatus(store) {
  const value = JSON.parse(await readFile(store.filename, 'utf8'))
  return { authenticated: true, expiresAt: new Date(value.expires) }
}
export async function readOpenAICodexRateLimits(store) {
  await appendFile(${JSON.stringify(refreshLog)}, 'refresh\\n')
  await writeFile(store.filename, JSON.stringify({ value: 'refreshed', expires: Date.now() + 86400000 }) + '\\n')
  return { rateLimits: [] }
}
`)
  return {
    authFile,
    hitch,
    refreshLog,
    env: {
      ...process.env,
      GEAR_HITCH_EXECUTABLE: hitch,
      GEAR_DSH_CODEX_MODULE: pathToFileURL(plugin).href,
      GEAR_TARGET_CODEX_AUTH_FILE: authFile,
    },
  }
}

describe('gear-hitch-codex', () => {
  it('passes non-launch commands through without requiring OAuth', async () => {
    const { hitch } = await fixture(Date.now() + 86_400_000)
    const { stdout } = await execute(process.execPath, [wrapper, '--version'], {
      env: { ...process.env, GEAR_HITCH_EXECUTABLE: hitch },
    })
    expect(stdout).toBe('0.2.6\n')
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

  it('injects the persistent credential without refreshing a valid token', async () => {
    const { authFile, env, refreshLog } = await fixture(Date.now() + 86_400_000)
    const expected = (await readFile(authFile)).toString('base64')
    const { stdout } = await execute(process.execPath, [wrapper, 'eval', 'run'], { env })
    expect(JSON.parse(stdout)).toEqual({ args: ['eval', 'run'], credential: expected })
    await expect(readFile(refreshLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists a refresh before injecting an expiring credential', async () => {
    const { authFile, env, refreshLog } = await fixture(Date.now() + 60_000)
    const { stdout } = await execute(process.execPath, [wrapper, '--root', '/tmp/hitch', 'eval', 'submit'], { env })
    const expected = (await readFile(authFile)).toString('base64')
    expect(JSON.parse(stdout)).toEqual({
      args: ['--root', '/tmp/hitch', 'eval', 'submit'],
      credential: expected,
    })
    expect(await readFile(refreshLog, 'utf8')).toBe('refresh\n')
    expect(Buffer.from(JSON.parse(stdout).credential, 'base64').toString()).toContain('refreshed')
  })
})
