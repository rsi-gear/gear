import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
    expect(await readFile(resolve(root, 'skills/refine/SKILL.md'), 'utf8')).toContain('name: refine')

    const patch = load(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string; disabled?: boolean }>
    }>
    expect(patch).toEqual([{ insert: [{ id: 'refine', name: 'dsh-plugin-refine', disabled: true }] }])
  })
})
