import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertMetaPresetIsolation } from '../../src/meta/isolation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('refine-meta preset isolation', () => {
  it('rejects skill and plugin paths that point into target harness artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-isolation-'))
    roots.push(root)
    const target = join(root, 'target-harness')
    const presetPath = join(root, 'meta', 'agent.cordis.yml')
    await mkdir(join(target, 'skills'), { recursive: true })
    await mkdir(join(root, 'meta'), { recursive: true })
    await writeFile(presetPath, [
      '- name: skill-filesystem',
      '  config:',
      `    customSkillDirs: [${JSON.stringify(join(target, 'skills'))}]`,
      '',
    ].join('\n'))
    await expect(assertMetaPresetIsolation(
      { id: 'refine-meta', trust: 'system', path: presetPath }, [target],
    )).rejects.toThrow(/references target harness/)
  })

  it('allows a fixed preset and skill catalog outside target roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-isolation-'))
    roots.push(root)
    const target = join(root, 'target-harness')
    const fixedSkills = join(root, 'fixed-skills')
    const presetPath = join(root, 'meta', 'agent.cordis.yml')
    await mkdir(target, { recursive: true })
    await mkdir(fixedSkills, { recursive: true })
    await mkdir(join(root, 'meta'), { recursive: true })
    await writeFile(presetPath, `- name: skill-filesystem\n  config:\n    customSkillDirs: [${JSON.stringify(fixedSkills)}]\n`)
    await expect(assertMetaPresetIsolation(
      { id: 'refine-meta', trust: 'system', path: presetPath }, [target],
    )).resolves.toBeUndefined()
  })

  it('rejects a symlink inside the preset that resolves into target content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-isolation-'))
    roots.push(root)
    const target = join(root, 'target-harness')
    const presetRoot = join(root, 'meta')
    const presetPath = join(presetRoot, 'agent.cordis.yml')
    await mkdir(join(target, 'skills'), { recursive: true })
    await mkdir(presetRoot, { recursive: true })
    await writeFile(join(target, 'skills', 'secret.md'), 'target-only\n')
    await writeFile(presetPath, '[]\n')
    await symlink(join(target, 'skills'), join(presetRoot, 'linked-skills'))
    await expect(assertMetaPresetIsolation(
      { id: 'refine-meta', trust: 'system', path: presetPath }, [target],
    )).rejects.toThrow(/contains a link/)
  })
})
