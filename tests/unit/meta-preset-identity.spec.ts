import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDshPresetRef, resolveDshRuntimeIdentity } from '../../src/meta/isolation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('resolved DSH preset identity', () => {
  it('hashes documents reached through external nested includes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-preset-includes-'))
    roots.push(root)
    await mkdir(join(root, 'preset'))
    await mkdir(join(root, 'external'))
    const path = join(root, 'preset/agent.cordis.yml')
    await writeFile(path, '- name: cordis:include\n  config:\n    path: ../external/entry.json\n')
    await writeFile(join(root, 'external/entry.json'), JSON.stringify([{ name: 'docs', config: { path: './guide.md' } }]))
    await writeFile(join(root, 'external/guide.md'), 'one')
    const preset = { id: 'meta', trust: 'system' as const, path }
    const before = await resolveDshPresetRef(preset)
    await writeFile(join(root, 'external/guide.md'), 'two')
    const after = await resolveDshPresetRef(preset)
    expect(after.digest).not.toBe(before.digest)
    expect(after.resources.some(value => value.logicalPath.endsWith('guide.md'))).toBe(true)
  })

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
