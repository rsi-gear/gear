import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertMetaPresetComposesCapabilities,
  assertMetaPresetIsolation,
} from '../../src/meta/isolation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('refine-meta preset isolation', () => {
  async function composition(files: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-includes-'))
    roots.push(root)
    for (const [path, entries] of Object.entries(files)) {
      await writeFile(join(root, path), typeof entries === 'string' ? entries : JSON.stringify(entries))
    }
    return { root, preset: { id: 'refine-meta', trust: 'system' as const, path: join(root, 'agent.cordis.yml') } }
  }

  const persona = (complete: boolean) => ({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { complete, text: 'fixed meta persona' } })
  const include = (path: string, extra = {}) => ({ name: 'cordis:include', config: { path, ...extra } })

  it('rejects a complete persona through nested JSON and YAML includes', async () => {
    const { preset } = await composition({
      'agent.cordis.yml': [include('./middle.json')],
      'middle.json': [include('./persona.yml')],
      'persona.yml': "- name: '@deepseek-ai/dsh-persona'\n  config:\n    complete: true\n    text: fixed\n",
    })
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('complete persona suppresses')
  })

  it.each([true, false])('uses Cordis patches rather than raw included persona config: %s', async complete => {
    const { preset } = await composition({
      'agent.cordis.yml': [include('./persona.json', { patches: [{ id: 'persona', config: { complete, text: 'patched' } }] })],
      'persona.json': [persona(!complete)],
    })
    if (complete) await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('complete persona suppresses')
    else await expect(assertMetaPresetComposesCapabilities(preset)).resolves.toBeUndefined()
  })

  it('checks inserted rows and inline groups', async () => {
    const { preset } = await composition({
      'agent.cordis.yml': [include('./empty.json', { patches: [{ insert: [{ name: 'cordis:group', group: true, config: [persona(true)] }] }] })],
      'empty.json': [],
    })
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('complete persona suppresses')
  })

  it('ignores disabled personas, groups, and includes', async () => {
    const { preset } = await composition({ 'agent.cordis.yml': [
      { ...persona(true), disabled: true },
      { name: 'cordis:group', group: true, disabled: true, config: [persona(true)] },
      { ...include('./missing.yml'), disabled: true },
      persona(false),
    ] })
    await expect(assertMetaPresetComposesCapabilities(preset)).resolves.toBeUndefined()
  })

  it('rejects cycles instead of recursing indefinitely', async () => {
    const { preset } = await composition({ 'agent.cordis.yml': [include('./loop.json')], 'loop.json': [include('./agent.cordis.yml')] })
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('cyclic or excessive')
  })

  it('does not execute dynamic configuration while checking it', async () => {
    const { preset } = await composition({
      'agent.cordis.yml': "- name: '@deepseek-ai/dsh-persona'\n  config:\n    complete: !!js 'true'\n    text: fixed\n",
    })
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('cannot verify dynamic')
  })

  it('checks initial configuration without creating an absent include file', async () => {
    const { preset } = await composition({ 'agent.cordis.yml': [include('./missing.yml', { initial: [persona(true)] })] })
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('complete persona suppresses')
  })

  it('resolves nested paths relative to the included URL, including symlink aliases', async () => {
    const { root, preset } = await composition({ 'agent.cordis.yml': [] })
    await mkdir(join(root, 'original'))
    await mkdir(join(root, 'alias'))
    await writeFile(join(root, 'original/include.yml'), JSON.stringify([include('./persona.yml')]))
    await writeFile(join(root, 'original/persona.yml'), JSON.stringify([persona(false)]))
    await writeFile(join(root, 'alias/persona.yml'), JSON.stringify([persona(true)]))
    await symlink(join(root, 'original/include.yml'), join(root, 'alias/include.yml'))
    await writeFile(preset.path, JSON.stringify([include(pathToFileURL(join(root, 'alias/include.yml')).href)]))
    await expect(assertMetaPresetComposesCapabilities(preset)).rejects.toThrow('complete persona suppresses')
  })

  it('checks target references hidden inside an external include', async () => {
    const { root, preset } = await composition({ 'agent.cordis.yml': [include('./external.json')], 'external.json': [] })
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(root, 'external.json'), JSON.stringify([{ name: 'docs', config: { path: target } }]))
    await expect(assertMetaPresetIsolation(preset, [target])).rejects.toThrow('references target harness')
  })

  it('rejects a complete persona that would suppress Gear capability guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-isolation-'))
    roots.push(root)
    const presetPath = join(root, 'agent.cordis.yml')
    await writeFile(presetPath, [
      "- name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    complete: true',
      '    text: fixed meta persona',
      '',
    ].join('\n'))
    await expect(assertMetaPresetComposesCapabilities(
      { id: 'refine-meta', trust: 'system', path: presetPath },
    )).rejects.toThrow(/complete persona suppresses Gear capability/)
  })

  it('accepts a composable persona', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-meta-isolation-'))
    roots.push(root)
    const presetPath = join(root, 'agent.cordis.yml')
    await writeFile(presetPath, [
      "- name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    complete: false',
      '    text: fixed meta persona',
      '',
    ].join('\n'))
    await expect(assertMetaPresetComposesCapabilities(
      { id: 'refine-meta', trust: 'system', path: presetPath },
    )).resolves.toBeUndefined()
  })

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
