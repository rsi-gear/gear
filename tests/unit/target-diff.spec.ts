import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { targetDiff } from '../../src/adapters/storage/target-diff.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-diff-'))
  roots.push(root)
  const adapter = new PiHarnessAdapter(),
    store = new TargetStore(root, adapter, canonicalDigest('runtime'))
  await adapter.prepare(store.path('anchor'))
  return {
    store,
    async copy() {
      const manifest = await store.seal('anchor', canonicalDigest('base'))
      await cp(store.path('anchor'), store.path('candidate'), { recursive: true })
      return { id: 'anchor', parent_id: null, digest: manifest.digest }
    },
    async seal() {
      return {
        id: 'candidate',
        parent_id: 'anchor',
        digest: (await store.seal('candidate', '', 'anchor')).digest,
      }
    },
  }
}

it('shows sorted native file additions, removals, content changes and executable mode changes', async () => {
  const { store, copy, seal } = await fixture()
  await writeFile(join(store.path('anchor'), '.pi/prompts/remove.md'), 'remove me\n')
  await writeFile(join(store.path('anchor'), '.pi/prompts/mode.md'), 'same bytes\n')
  const anchor = await copy()
  await rm(join(store.path('candidate'), '.pi/prompts/remove.md'))
  await chmod(join(store.path('candidate'), '.pi/prompts/mode.md'), 0o500)
  await writeFile(join(store.path('candidate'), '.pi/prompts/add.md'), 'added text\n')
  await chmod(join(store.path('candidate'), 'AGENTS.md'), 0o600)
  await writeFile(join(store.path('candidate'), 'AGENTS.md'), 'new rule\n')
  const candidate = await seal()
  const diff = await targetDiff(store, anchor, candidate)
  expect(diff.from.digest).toBe(anchor.digest)
  expect(diff.to.digest).toBe(candidate.digest)
  expect(diff.omitted_patches).toBe(0)
  expect(diff.files.map((file) => [file.path, file.change])).toEqual([
    ['.pi/prompts/add.md', 'added'],
    ['.pi/prompts/mode.md', 'modified'],
    ['.pi/prompts/remove.md', 'removed'],
    ['AGENTS.md', 'modified'],
  ])
  expect(diff.files[0]!.patch).toContain('+added text')
  expect(diff.files[1]).toMatchObject({
    patch: null,
    patch_status: 'unchanged',
    before: { executable: false },
    after: { executable: true },
  })
  expect(diff.files[2]!.patch).toContain('-remove me')
  expect(diff.files[3]!.patch).toContain('+new rule')
  expect(await targetDiff(store, anchor, candidate)).toEqual(diff)
  expect((await targetDiff(store, anchor, anchor)).files).toEqual([])
})

it('retains identity metadata and omission reasons for binary, invalid UTF-8 and large resources', async () => {
  const { store, copy, seal } = await fixture()
  const anchor = await copy()
  await writeFile(join(store.path('candidate'), '.pi/prompts/binary'), Buffer.from([0, 1, 2]))
  await writeFile(join(store.path('candidate'), '.pi/prompts/invalid'), Buffer.from([0xff, 0xfe]))
  await writeFile(join(store.path('candidate'), '.pi/prompts/large'), 'x'.repeat(65537))
  const diff = await targetDiff(store, anchor, await seal())
  expect(diff.omitted_patches).toBe(3)
  expect(diff.files.map((file) => file.patch_status)).toEqual(['binary', 'binary', 'too-large'])
  expect(diff.files.every((file) => file.after?.digest.startsWith('sha256:') && file.patch === null)).toBe(
    true,
  )
})

it('bounds total patch bytes without dropping changed files from the report', async () => {
  const { store, copy, seal } = await fixture()
  const anchor = await copy()
  for (let index = 0; index < 4; index++)
    await writeFile(join(store.path('candidate'), `.pi/prompts/${index}.md`), String(index).repeat(60000))
  const diff = await targetDiff(store, anchor, await seal())
  expect(diff.files).toHaveLength(4)
  expect(diff.omitted_patches).toBe(2)
  expect(diff.files.map((file) => file.patch_status)).toEqual([
    'included',
    'included',
    'budget-exhausted',
    'budget-exhausted',
  ])
  expect(diff.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch ?? ''), 0)).toBeLessThanOrEqual(
    128 * 1024,
  )
})

it('bounds edit complexity and refuses unsealed bytes or mismatched journal identities', async () => {
  const { store, copy, seal } = await fixture()
  await writeFile(
    join(store.path('anchor'), '.pi/prompts/complex.md'),
    Array.from({ length: 1200 }, (_, i) => `old-${i}\n`).join(''),
  )
  const anchor = await copy()
  const path = join(store.path('candidate'), '.pi/prompts/complex.md')
  await chmod(path, 0o600)
  await writeFile(path, Array.from({ length: 1200 }, (_, i) => `new-${i}\n`).join(''))
  const candidate = await seal()
  expect((await targetDiff(store, anchor, candidate)).files[0]!.patch_status).toBe('too-complex')
  await expect(targetDiff(store, anchor, { ...anchor, digest: candidate.digest })).rejects.toMatchObject({
    code: 'target-identity-mismatch',
  })
  await chmod(path, 0o600)
  await writeFile(path, 'unsealed data')
  await expect(targetDiff(store, anchor, candidate)).rejects.toMatchObject({
    code: 'target-identity-mismatch',
  })
})
