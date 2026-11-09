import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const example = join(root, 'examples', 'dsh-codex-luna')
const temporaryRoots: string[] = []

function sha256(value: string | Buffer) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DSH Codex Luna example', () => {
  it('pins the validated control-plane and target plugin versions', async () => {
    const runtime = JSON.parse(await readFile(join(example, 'runtime.package.json'), 'utf8'))
    const target = JSON.parse(await readFile(join(example, 'target-carrier', 'package.json'), 'utf8'))
    expect(runtime.dependencies['@deepseek-ai/dsh']).toBe('0.1.1-rc.2')
    expect(runtime.dependencies['@earendil-works/pi-ai']).toBe('0.84.4')
    expect(target.dependencies).toMatchObject({
      '@deepseek-ai/dsh': '0.1.1-rc.2',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
      '@earendil-works/pi-ai': '0.84.4',
      'dsh-codex': '0.2.6',
    })
    const targetLauncher = await readFile(join(example, 'target-carrier', 'apps', 'cli', 'lib', 'bin.js'), 'utf8')
    expect(targetLauncher).toContain("process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'")
    expect(targetLauncher).toContain('DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64')
    expect(targetLauncher).toContain("refresh: 'disabled-in-disposable-target'")
  })

  it('bootstraps an exact-commit target with a valid harness manifest', async () => {
    const labRoot = await mkdtemp(join(tmpdir(), 'gear-luna-example-'))
    temporaryRoots.push(labRoot)
    const targetRoot = join(labRoot, 'target-dsh')
    const bootstrap = join(example, 'bootstrap-target.mjs')
    const { stdout } = await execute(process.execPath, [bootstrap, targetRoot], {
      cwd: root,
      env: { ...process.env, GEAR_LAB_ROOT: labRoot, GEAR_SKIP_TARGET_INSTALL: '1' },
    })
    const metadata = JSON.parse(stdout)
    expect(metadata.targetRepository).toBe(targetRoot)
    expect(metadata.dshBaseRef).toMatch(/^[0-9a-f]{40}$/u)
    expect(metadata.initialChampion.ref).toMatch(/^[0-9a-f]{40}$/u)
    const { stdout: ancestor } = await execute('git', [
      '-C', targetRoot,
      'merge-base', '--is-ancestor',
      metadata.dshBaseRef,
      metadata.initialChampion.ref,
    ])
    expect(ancestor).toBe('')

    const manifestText = await readFile(join(targetRoot, 'harness', 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestText)
    const identity = {
      schemaVersion: manifest.schemaVersion,
      parentRef: manifest.parentRef,
      dshBaseRef: manifest.dshBaseRef,
      toolchainRef: manifest.toolchainRef,
      sandboxProfileRef: manifest.sandboxProfileRef,
      artifacts: manifest.artifacts,
    }
    expect(manifest.dshBaseRef).toBe(metadata.dshBaseRef)
    expect(manifest.parentRef).toBe(metadata.dshBaseRef)
    expect(manifest.digest).toBe(sha256(JSON.stringify(identity)))
    expect(metadata.initialChampion.manifestDigest).toBe(manifest.digest)
  })

  it.each(['automationbench-marketing', 'evolution-search'])('imports the %s harness with fresh carrier identity and unchanged artifact bytes', async name => {
    const labRoot = await mkdtemp(join(tmpdir(), 'gear-imported-example-'))
    temporaryRoots.push(labRoot)
    const targetRoot = join(labRoot, 'target-dsh')
    const source = join(root, 'examples', name, 'harness')
    const original = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
    const { stdout } = await execute(process.execPath, [join(example, 'bootstrap-target.mjs'), targetRoot], {
      cwd: root,
      env: { ...process.env, GEAR_LAB_ROOT: labRoot, GEAR_SKIP_TARGET_INSTALL: '1', GEAR_INITIAL_HARNESS: source },
    })
    const metadata = JSON.parse(stdout)
    const imported = JSON.parse(await readFile(join(targetRoot, 'harness', 'manifest.json'), 'utf8'))
    expect(imported.digest).not.toBe(original.digest)
    expect(imported.parentRef).toBe(metadata.dshBaseRef)
    expect(imported.artifacts).toEqual(original.artifacts)
    for (const artifact of original.artifacts) {
      expect(await readFile(join(targetRoot, 'harness', artifact.path))).toEqual(await readFile(join(source, artifact.path)))
    }
    expect(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))).toEqual(original)
  })

  it('defaults both Meta and target agents to configurable Luna models', async () => {
    const patch = await readFile(join(example, 'profile.patch.yml'), 'utf8')
    const targetPatch = await readFile(join(example, 'target-carrier', 'fixed', 'target.patch.yml'), 'utf8')
    const launcher = await readFile(join(example, 'evolve.mjs'), 'utf8')
    expect(patch).toMatch(/metaAdapter:\n\s+kind: skill/u)
    expect(patch).not.toContain('metaPreset:')
    expect(patch).toContain("process.env.GEAR_META_MODEL ?? 'gpt-5.6-luna'")
    expect(patch).toContain("process.env.GEAR_TARGET_MODEL ?? 'gpt-5.6-luna'")
    expect(patch).toMatch(/metaSampling:\n\s+temperature: 1\n\s+reasoningEffort: medium/u)
    expect(targetPatch).toMatch(/repositoryRoot: [^\n]+\n\s+reasoningEffort: medium/u)
    expect(launcher).toContain("GEAR_TARGET_CODEX_ENV: process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'")
    expect(patch).toMatch(/attempts: 3\n\s+maxConcurrent: !!js Number\(process\.env\.GEAR_TARGET_MAX_CONCURRENT \?\? 12\)/u)
    expect(launcher).toContain("'--attempts', '3'")
    expect(launcher).toContain("process.env.GEAR_TARGET_MAX_CONCURRENT ?? '12'")
    expect(launcher).toContain("'--infrastructure-retries', '0'")
    expect(launcher).not.toContain('.codex/auth.json')
  })

  it('persists Medium before target readiness across harness revisions and Hitch model selections', async () => {
    const labRoot = await mkdtemp(join(tmpdir(), 'gear-luna-effort-'))
    temporaryRoots.push(labRoot)
    const targetRoot = join(labRoot, 'target-dsh')
    await execute(process.execPath, [join(example, 'bootstrap-target.mjs'), targetRoot], {
      cwd: root,
      env: { ...process.env, GEAR_LAB_ROOT: labRoot, GEAR_SKIP_TARGET_INSTALL: '1' },
    })
    const targetLoader = await import(pathToFileURL(join(example, 'target-carrier', 'fixed', 'target-loader.js')).href)
    expect(targetLoader.inject).toEqual(expect.arrayContaining(['agentDefaultModel', 'settings']))
    const manifestPath = join(targetRoot, 'harness', 'manifest.json')
    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const observedDigests: string[] = []

    for (const selected of [
      { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' },
      { provider: 'hitch-override', model: 'another-model', reasoningEffort: 'low' },
    ]) {
      let stored = { ...selected }
      let releaseSave!: () => void
      let saveStarted!: () => void
      const saving = new Promise<void>(resolvePromise => { releaseSave = resolvePromise })
      const started = new Promise<void>(resolvePromise => { saveStarted = resolvePromise })
      let ready = false
      const context = {
        plugin: async () => {},
        agentDefaultModel: {
          currentSelection: () => ({ ...stored }),
          saveSelection: async (selection: typeof stored) => {
            saveStarted()
            await saving
            stored = { ...selection }
          },
        },
        provide: (name: string, target: { ref: string }) => {
          expect(name).toBe('targetHarness')
          expect(stored).toEqual({ ...selected, reasoningEffort: 'medium' })
          observedDigests.push(target.ref)
          ready = true
        },
      }
      const loading = targetLoader.apply(context, { repositoryRoot: targetRoot, reasoningEffort: 'medium' })
      await started
      expect(ready).toBe(false)
      releaseSave()
      await loading
      expect(ready).toBe(true)

      if (observedDigests.length === 1) {
        const policy = join(targetRoot, 'harness', 'plugins', 'policy.js')
        await writeFile(policy, `${await readFile(policy, 'utf8')}\n// LUNA_HARNESS_ITERATION_CHECK\n`)
        const artifacts = await Promise.all(firstManifest.artifacts.map(async (artifact: { path: string }) => {
          const content = await readFile(join(targetRoot, 'harness', artifact.path))
          return { path: artifact.path, digest: sha256(content), bytes: content.byteLength }
        }))
        const { digest: _oldDigest, ...identity } = firstManifest
        const nextIdentity = { ...identity, artifacts }
        await writeFile(manifestPath, JSON.stringify({ ...nextIdentity, digest: sha256(JSON.stringify(nextIdentity)) }))
      }
    }
    expect(observedDigests).toHaveLength(2)
    expect(observedDigests[0]).toBe(firstManifest.digest)
    expect(observedDigests[1]).not.toBe(firstManifest.digest)
  })

  it.each([undefined, null, 1, '', ' ', ' medium', 'medium '])('rejects invalid target effort %j before exposing the target to headless', async reasoningEffort => {
    const targetLoader = await import(pathToFileURL(join(example, 'target-carrier', 'fixed', 'target-loader.js')).href)
    await expect(targetLoader.apply({}, { repositoryRoot: '/unused', reasoningEffort }))
      .rejects.toThrow('target reasoning effort must be a non-empty effort id without surrounding whitespace')
  })

  it('keeps the outer Loader entry pending until native settings services and target setup complete', async () => {
    const labRoot = await mkdtemp(join(tmpdir(), 'gear-luna-loader-'))
    temporaryRoots.push(labRoot)
    const targetRoot = join(labRoot, 'target-dsh')
    await execute(process.execPath, [join(example, 'bootstrap-target.mjs'), targetRoot], {
      cwd: root,
      env: { ...process.env, GEAR_LAB_ROOT: labRoot, GEAR_SKIP_TARGET_INSTALL: '1' },
    })
    vi.stubEnv('DSH_REFINE_TARGET_LOADER_URL', pathToFileURL(join(example, 'target-carrier', 'fixed', 'target-loader.js')).href)
    const shim = await import(pathToFileURL(join(example, 'target-carrier', 'fixed', 'target-loader-shim.js')).href)
    let stored = { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' }
    let runnerSelection: typeof stored | undefined
    let policyMounted = false
    const services = {
      name: 'target-test-services',
      async apply(ctx: Context) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
        ctx.provide('settings', {} as never)
        ctx.provide('systemPrompt', { section: () => { policyMounted = true } } as never)
        ctx.provide('agentDefaultModel', {
          currentSelection: () => ({ ...stored }),
          async saveSelection(next: typeof stored) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
            stored = { ...next }
          },
        } as never)
      },
    }
    const runner = {
      name: 'target-test-runner',
      inject: ['targetHarness'],
      apply() { runnerSelection = { ...stored } },
    }
    const configPath = join(labRoot, 'entry.json')
    await writeFile(configPath, JSON.stringify([
      { name: 'target-test-shim', config: { repositoryRoot: targetRoot, reasoningEffort: 'medium' } },
      { name: services.name },
      { name: runner.name },
    ]))
    const context = new Context()
    context.baseUrl = `${pathToFileURL(labRoot).href}/`
    try {
      await context.plugin(Loader)
      context.loader.builtins.include = Include
      const modules = new Map<string, unknown>([['target-test-shim', shim], [services.name, services], [runner.name, runner]])
      context.loader.internal = {
        version: 'v2',
        async import(specifier: string, baseUrl: string) {
          return modules.has(specifier) ? modules.get(specifier) : import(new URL(specifier, baseUrl).href)
        },
      } as never
      await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await context.loader.await()
      expect(policyMounted).toBe(true)
      expect(runnerSelection).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium' })
    } finally {
      await context.fiber.dispose()
    }
  })
})
