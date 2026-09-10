import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const hitchRoot = process.env.HITCH_CREDENTIAL_CONTRACT_ROOT
const helper = resolve('assets/hitch-codex-credential-helper.mjs')
const roots: string[] = []

function findPython39(): string | undefined {
  for (const executable of [
    process.env.HITCH_PYTHON_PATH, 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3',
  ]) {
    if (executable === undefined) continue
    const probe = spawnSync(executable, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'], {
      stdio: 'ignore', timeout: 5_000,
    })
    if (probe.status === 0) return executable
  }
  return undefined
}

const python = findPython39()

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe.skipIf(hitchRoot === undefined || python === undefined)('Hitch host credential helper contract', () => {
  it('lets the real Hitch consumer obtain an access-only Gear credential without refreshing it', async () => {
    const source = resolve(hitchRoot!)
    const consumer = join(source, 'integrations', 'harbor', 'hitch_host_credentials.py')
    expect(existsSync(consumer)).toBe(true)

    const root = await mkdtemp(join(tmpdir(), 'gear-hitch-credential-contract-'))
    roots.push(root)
    const authFile = join(root, 'auth.json')
    const refreshLog = join(root, 'refresh.log')
    const dshCodex = join(root, 'dsh-codex.mjs')
    const piAiRoot = join(root, 'node_modules', '@earendil-works', 'pi-ai')
    const piAiDist = join(piAiRoot, 'dist')
    const expires = Date.now() + 60 * 60_000
    const minimumValidityMs = 90_000
    const access = 'isolated-contract-access'
    const refresh = 'isolated-contract-refresh'
    const credentialName = 'DSH_OPENAI_CODEX_ACCESS_B64'

    await mkdir(join(piAiDist, 'providers'), { recursive: true })
    await writeFile(authFile, `${JSON.stringify({
      version: 1,
      credential: { type: 'oauth', access, refresh, expires, accountId: 'contract-account' },
    })}\n`, { mode: 0o600 })
    await chmod(authFile, 0o600)
    await writeFile(dshCodex, `
import { readFile, writeFile } from 'node:fs/promises'
export const OPENAI_CODEX_PROVIDER = 'openai-codex'
export class OpenAICodexCredentialStore {
  constructor(filename) { this.filename = filename }
  async read() { return JSON.parse(await readFile(this.filename, 'utf8')).credential }
  async modify(provider, callback) {
    const current = await this.read(provider)
    const replacement = await callback(current)
    if (replacement !== undefined) {
      await writeFile(${JSON.stringify(refreshLog)}, 'refresh attempted\\n')
      await writeFile(this.filename, JSON.stringify({ version: 1, credential: replacement }) + '\\n')
      return replacement
    }
    return current
  }
}
`)
    await writeFile(join(piAiRoot, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-ai', version: '0.0.0-contract', type: 'module',
    }))
    await writeFile(join(piAiDist, 'index.js'), `
export function createModels({ credentials }) {
  return {
    setProvider() {},
    async getAuth(provider, options = {}) {
      const credential = await credentials.read(provider)
      if (Date.now() + (options.minOAuthValidityMs ?? 0) >= credential.expires) {
        throw new Error('fixture credential would require refresh')
      }
      return { auth: { apiKey: credential.access } }
    },
  }
}
`)
    await writeFile(join(piAiDist, 'providers', 'openai-codex.js'), `
export function openaiCodexProvider() { return { id: 'openai-codex' } }
`)

    const config = {
      version: 1,
      argv: [process.execPath, helper],
      credentialNames: [credentialName],
      timeoutMs: 10_000,
    }
    const script = `
import asyncio
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hitch_host_credentials", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
name = sys.argv[2]
validity = int(sys.argv[3])
loaded = module.load_host_credential_helper([name])
values = asyncio.run(module.prepare_host_credentials(loaded, validity))
print(json.dumps({
    "argv": list(loaded.argv),
    "credentialNames": list(loaded.credential_names),
    "timeoutMs": loaded.timeout_ms,
    "env": values,
}, separators=(",", ":"), sort_keys=True))
`
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GEAR_DSH_CODEX_MODULE: pathToFileURL(dshCodex).href,
      GEAR_TARGET_CODEX_AUTH_FILE: authFile,
      GEAR_TARGET_CODEX_ENV: credentialName,
      HITCH_HOST_CREDENTIAL_HELPER_JSON: JSON.stringify(config),
      PYTHONDONTWRITEBYTECODE: '1',
    }
    delete environment[credentialName]
    const stdout = execFileSync(python!, ['-c', script, consumer, credentialName, String(minimumValidityMs)], {
      encoding: 'utf8',
      env: environment,
      timeout: 15_000,
    })
    const result = JSON.parse(stdout) as {
      argv: string[]
      credentialNames: string[]
      timeoutMs: number
      env: Record<string, string>
    }
    expect(result).toMatchObject({
      argv: [process.execPath, helper],
      credentialNames: [credentialName],
      timeoutMs: 10_000,
    })
    expect(Object.keys(result.env)).toEqual([credentialName])
    const envelope = JSON.parse(Buffer.from(result.env[credentialName]!, 'base64').toString('utf8')) as Record<string, unknown>
    expect(envelope).toEqual({ version: 1, access, expires, accountId: 'contract-account' })
    expect(envelope).not.toHaveProperty('refresh')
    expect((await stat(authFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(authFile, 'utf8')).credential).toMatchObject({ access, refresh, expires })
    expect(existsSync(refreshLog)).toBe(false)

    const hitch = join(source, 'dist', 'bin', 'hitch.js')
    if (existsSync(hitch)) {
      const harbor = join(root, 'harbor.mjs')
      const docker = join(root, 'docker.mjs')
      await writeFile(harbor, '#!/usr/bin/env node\nprocess.stdout.write("harbor 0.21.0\\n")\n')
      await writeFile(docker, '#!/usr/bin/env node\nprocess.stdout.write("25.0.0\\n")\n')
      await Promise.all([chmod(harbor, 0o755), chmod(docker, 0o755)])
      const doctor = JSON.parse(execFileSync(process.execPath, [
        hitch, '--root', join(root, 'hitch-state'), 'eval', 'doctor', '--json',
        '--python', python!, '--harbor', harbor, '--docker', docker,
      ], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })) as { capabilities?: string[] }
      expect(doctor.capabilities).toContain('host-task-credential-helper-v1')
    }
  }, 20_000)
})
