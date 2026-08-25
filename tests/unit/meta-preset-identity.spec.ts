import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDshPresetRef, resolveDshRuntimeIdentity } from '../../src/meta/isolation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('resolved DSH preset identity', () => {
  it('derives the DSH runtime identity from installed package bytes', async () => {
    await expect(resolveDshRuntimeIdentity()).resolves.toMatchObject({
      type: 'dsh', version: expect.any(String), integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
  })

  it('changes when an Agent-visible prompt, skill, or external document changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-preset-'))
    roots.push(root)
    const presetRoot = join(root, 'preset')
    const external = join(root, 'knowledge.md')
    await mkdir(join(presetRoot, 'skills'), { recursive: true })
    await writeFile(join(presetRoot, 'agent.cordis.yml'), `- name: docs\n  config:\n    paths: [${JSON.stringify(external)}]\n`)
    await writeFile(join(presetRoot, 'system.md'), 'system one\n')
    await writeFile(join(presetRoot, 'skills', 'diagnose.md'), 'skill one\n')
    await writeFile(external, 'knowledge one\n')
    const preset = { id: 'meta', trust: 'system' as const, path: join(presetRoot, 'agent.cordis.yml') }

    const first = await resolveDshPresetRef(preset)
    expect(first.resources.map(resource => resource.kind)).toEqual(expect.arrayContaining(['composition', 'system-prompt', 'skill', 'document']))
    await writeFile(external, 'knowledge two\n')
    const second = await resolveDshPresetRef(preset)
    expect(second.digest).not.toBe(first.digest)
    expect(second.resources.find(resource => resource.logicalPath.startsWith('reference:'))?.digest)
      .not.toBe(first.resources.find(resource => resource.logicalPath.startsWith('reference:'))?.digest)
  })
})
