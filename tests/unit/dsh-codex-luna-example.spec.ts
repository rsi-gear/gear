import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const example = join(root, 'examples', 'dsh-codex-luna')
const temporaryRoots: string[] = []

function sha256(value: string | Buffer) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

afterEach(async () => Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('DSH Codex Luna example', () => {
  it('pins the validated control-plane and target plugin versions', async () => {
    const runtime = JSON.parse(await readFile(join(example, 'runtime.package.json'), 'utf8'))
    const target = JSON.parse(await readFile(join(example, 'target-carrier', 'package.json'), 'utf8'))
    expect(runtime.dependencies['@deepseek-ai/dsh']).toBe('0.1.1-rc.2')
    expect(runtime.dependencies['@earendil-works/pi-ai']).toBe('0.84.4')
    expect(target.dependencies).toMatchObject({
      '@deepseek-ai/dsh': '0.1.1-rc.2',
      '@earendil-works/pi-ai': '0.84.4',
      'dsh-codex': '0.2.6',
    })
    const targetLauncher = await readFile(join(example, 'target-carrier', 'apps', 'cli', 'lib', 'bin.js'), 'utf8')
    expect(targetLauncher).toContain("process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'")
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

  it('defaults both Meta and target agents to configurable Luna models', async () => {
    const patch = await readFile(join(example, 'profile.patch.yml'), 'utf8')
    const launcher = await readFile(join(example, 'evolve.mjs'), 'utf8')
    expect(patch).toContain("process.env.GEAR_META_MODEL ?? 'gpt-5.6-luna'")
    expect(patch).toContain("process.env.GEAR_TARGET_MODEL ?? 'gpt-5.6-luna'")
    expect(launcher).toContain("GEAR_TARGET_CODEX_ENV: process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'")
    expect(launcher).not.toContain('.codex/auth.json')
  })
})
