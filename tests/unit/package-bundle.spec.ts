import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe('published Gear bundle', () => {
  it('ships the standalone skill entry and an install-safe dormant DSH row', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('assets/llm-verifier-bridge.py')
    expect(pkg.files).toContain('skills/refine/**')
    expect(pkg.bin).toEqual({ 'gear-refine': './lib/cli.js' })
    expect(pkg.exports).toHaveProperty('./skill')
    const skillPath = resolve(root, 'skills/refine/SKILL.md')
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('name: refine')
    const references = [...skill.matchAll(/\]\((references\/[^)]+)\)/gu)].map(match => match[1]!)
    expect(new Set(references)).toEqual(new Set([
      'references/protocol.md',
      'references/target-harness-editing.md',
    ]))
    await expect(Promise.all(references.map(path => readFile(resolve(dirname(skillPath), path), 'utf8'))))
      .resolves.toHaveLength(2)

    const patch = load(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string; disabled?: boolean }>
    }>
    expect(patch).toEqual([{ insert: [{ id: 'refine', name: 'dsh-plugin-refine', disabled: true }] }])
  })
})
