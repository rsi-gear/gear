import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineStateStore } from '../../src/state/store.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('RefineCapabilities Git projection', () => {
  it('reads only manifest-indexed files from the exact champion commit', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const store = new RefineStateStore(`${fixture.root}/state`)
    await store.initialize()
    await store.writeChampion({
      schemaVersion: 2, ref: fixture.championRef, manifestDigest: fixture.manifest.digest, updatedAt: 'now',
    })
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository,
      targetRoot: fixture.targetRoot,
      dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    const capabilities = new RefineCapabilities({} as never, store, {} as never, builder, () => undefined)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.current', {})).resolves.toMatchObject({
      ref: fixture.championRef,
      digest: fixture.manifest.digest,
    })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: 'plugins/context.ts',
    })).resolves.toMatchObject({ text: 'export const value = 1\n', eof: true })
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: '../package.json',
    })).rejects.toThrow(/escapes|not normalized/)
    await expect(capabilities.call('refine-meta', 'meta', 'harness.read', {
      ref: fixture.championRef, path: 'plugins/not-in-manifest.ts',
    })).rejects.toThrow(/not in the target manifest/)
  })
})
