import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('HarnessBuilder exact commit validation', () => {
  it('reads a pinned manifest even when the source checkout has unrelated local edits', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    await writeFile(join(fixture.repository, 'untracked-user-file.txt'), 'preserve me\n')
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot, dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    expect((await builder.readManifest(fixture.championRef)).digest).toBe(fixture.manifest.digest)
    expect((await builder.readHarnessFile(fixture.championRef, 'plugins/context.ts')).content).toBe('export const value = 1\n')
  })

  it('rejects a commit whose manifest does not match target bytes', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot, dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    await writeFile(join(fixture.repository, 'harness', 'plugins', 'context.ts'), 'export const value = 999\n')
    gitOutput(fixture.repository, ['add', 'harness/plugins/context.ts'])
    gitOutput(fixture.repository, ['commit', '-m', 'tamper target without updating manifest'])
    const tampered = gitOutput(fixture.repository, ['rev-parse', 'HEAD'])
    await expect(builder.readManifest(tampered)).rejects.toThrow(/integrity mismatch/)
  })
})
