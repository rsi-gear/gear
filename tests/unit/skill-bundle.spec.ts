import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBundledRefineSkill } from '../../src/skill/bundle.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-skill-bundle-'))
  roots.push(root)
  await cp(fileURLToPath(new URL('../../skills/refine/', import.meta.url)), root, { recursive: true })
  return root
}

describe('packaged skill resource identity', () => {
  it('records all resources with a stable, relocation-independent digest', async () => {
    const bundled = await loadBundledRefineSkill()
    const copy = await loadBundledRefineSkill(await fixture())
    expect(copy.resources).toEqual(bundled.resources)
    expect(copy.digest).toBe(bundled.digest)
    expect(copy.resources.map(value => value.logicalPath)).toEqual([
      'SKILL.md', 'agents/openai.yaml', 'references/dsh-target-harness.md',
      'references/protocol.md', 'references/target-harness-editing.md',
      'scripts/transport.mjs',
    ])
    expect(copy.digest).toBe(`sha256:${createHash('sha256').update(JSON.stringify(copy.resources)).digest('hex')}`)
  })

  it.each(['references/protocol.md', 'references/target-harness-editing.md', 'agents/openai.yaml'])('changes identity for a reference/metadata-only update to %s', async path => {
    const root = await fixture()
    const before = await loadBundledRefineSkill(root)
    await writeFile(join(root, path), 'updated resource\n')
    const after = await loadBundledRefineSkill(root)
    expect(after.content).toBe(before.content)
    expect(after.digest).not.toBe(before.digest)
  })

  it('includes added resources and detects removal', async () => {
    const root = await fixture()
    const before = await loadBundledRefineSkill(root)
    await mkdir(join(root, 'helpers'))
    await writeFile(join(root, 'helpers/helper.js'), 'export const version = 1\n')
    const added = await loadBundledRefineSkill(root)
    expect(added.digest).not.toBe(before.digest)
    await rm(join(root, 'references/protocol.md'))
    expect((await loadBundledRefineSkill(root)).digest).not.toBe(added.digest)
  })

  it('rejects resource symlinks rather than omitting external instruction bytes', async () => {
    const root = await fixture()
    await symlink(join(root, 'SKILL.md'), join(root, 'references/link.md'))
    await expect(loadBundledRefineSkill(root)).rejects.toThrow('non-regular resource')
  })
})
