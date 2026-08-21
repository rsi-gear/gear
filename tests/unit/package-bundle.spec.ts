import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe('published DSH bundle', () => {
  it('declares an install-safe dormant refine row', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')

    const patch = load(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string; disabled?: boolean }>
    }>
    expect(patch).toEqual([{ insert: [{ id: 'refine', name: 'dsh-plugin-refine', disabled: true }] }])
  })
})
