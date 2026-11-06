import { chmod, cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore, targetResources } from '../../src/adapters/storage/targets.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([new DshHarnessAdapter(), new PiHarnessAdapter()])('seals native resources and detects changed bytes for $constructor.name', async adapter => {
  const root = await mkdtemp(join(tmpdir(), 'gear-target-')); roots.push(root)
  const store = new TargetStore(root, adapter, canonicalDigest('runtime'))
  await adapter.prepare(store.path('anchor'))
  const base = canonicalDigest(await targetResources(store.path('anchor')))
  const anchor = await store.seal('anchor', base)
  expect(anchor.version).toBe(2)
  expect(await store.verify('anchor')).toEqual(anchor)
  await cp(store.path('anchor'), store.path('candidate'), { recursive: true })
  const resource = adapter.describe().adapterRef.id === 'pi' ? 'AGENTS.md' : 'prompts/system.md'
  const rule = join(store.path('candidate'), resource)
  await chmod(rule, 0o600); await writeFile(rule, 'improved instruction')
  const candidate = await store.seal('candidate', '', 'anchor')
  expect(candidate.baseRef).toBe(anchor.baseRef)
  expect(candidate.digest).not.toBe(anchor.digest)
  expect((await store.seal('candidate', '', 'anchor')).digest).toBe(candidate.digest)
  await chmod(rule, 0o600); await writeFile(rule, 'changed after sealing')
  await expect(store.verify('candidate')).rejects.toThrow('changed')
  expect(await readFile(join(store.path('anchor'), resource), 'utf8')).not.toContain('improved')
})

it('rejects substrate edits, links and changed runtime conditions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-target-policy-')); roots.push(root)
  const adapter = new PiHarnessAdapter(), store = new TargetStore(root, adapter, canonicalDigest('runtime'))
  await adapter.prepare(store.path('anchor')); await store.seal('anchor', canonicalDigest('base'))
  await cp(store.path('anchor'), store.path('candidate'), { recursive: true })
  await writeFile(join(store.path('candidate'), 'package.json'), '{}')
  await expect(store.seal('candidate', '', 'anchor')).rejects.toThrow('protected')
  await rm(join(store.path('candidate'), 'package.json'))
  await symlink('/etc/hosts', join(store.path('candidate'), 'secret'))
  await expect(store.seal('candidate', '', 'anchor')).rejects.toThrow('links')
  await expect(new TargetStore(root, adapter, canonicalDigest('other-runtime')).verify('anchor')).rejects.toThrow('changed')
})
