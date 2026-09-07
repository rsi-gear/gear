import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js'
import { roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('HarnessBuilder dependency allowlist', () => {
  const cases: Array<{ specifier: string; allowedImports?: string[]; accepted: boolean; source?: string; path?: string }> = [
    { specifier: 'node:url', accepted: true },
    { specifier: 'node:path', accepted: true },
    { specifier: 'node:fs/promises', accepted: true },
    { specifier: 'node:test', accepted: true },
    { specifier: 'node:url', allowedImports: ['node:url'], accepted: true },
    { specifier: 'node:fs', allowedImports: ['node:url'], accepted: false },
    { specifier: 'node:url', allowedImports: ['@deepseek-ai/'], accepted: false },
    { specifier: 'node:url', allowedImports: [], accepted: false },
    { specifier: 'url', accepted: false },
    { specifier: 'fs', accepted: false },
    { specifier: 'unapproved-package', accepted: false },
    { specifier: '@deepseek-ai/dsh-skill-filesystem', accepted: true },
    { specifier: 'node:not-a-real-builtin', allowedImports: ['node:'], accepted: false },
    { specifier: 'node:', allowedImports: ['node:'], accepted: false },
    { specifier: 'comment', source: '// import "example-package"\n/* from "example-package" */\nexport const value = 1', accepted: true },
    { specifier: 'prompt text', source: 'export const text = `Use require("example-package") or import("example-package").`', accepted: true },
    { specifier: 'string', source: 'export const text = "from \'example-package\'"', accepted: true },
    { specifier: 'regex', source: 'export const pattern = /from "example-package"/', accepted: true },
    { specifier: 'method', source: 'export const value = policy.require("example-package")', accepted: true },
    { specifier: 'JSX text', path: 'plugins/imports.tsx', source: 'export const text = <p>import "example-package"</p>', accepted: true },
    { specifier: 'unapproved-package', source: 'import /* module */ "unapproved-package"', accepted: false },
    { specifier: 'unapproved-package', source: 'export { value } from "unapproved-package"', accepted: false },
    { specifier: 'unapproved-package', source: 'export const value = require("unapproved-package")', accepted: false },
    { specifier: 'unapproved-package', path: 'plugins/imports.cjs', source: 'module.exports = module.require("unapproved-package")', accepted: false },
    { specifier: 'unapproved-package', source: 'export const value = import(`unapproved-package`)', accepted: false },
    { specifier: 'unapproved-package', source: 'export const text = `${import("unapproved-package")}`', accepted: false },
    { specifier: 'unapproved-package', path: 'plugins/imports.ts', source: 'import legacy = require("unapproved-package")', accepted: false },
    { specifier: 'unapproved-package', path: 'plugins/imports.ts', source: 'export type Example = import("unapproved-package").Example', accepted: false },
  ]
  it.each(cases)('checks $specifier with allowlist $allowedImports', async ({ specifier, allowedImports, accepted, source, path = 'plugins/imports.js' }) => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const manager = new CandidateWorkspaceManager({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
      rootForEvolution: id => join(fixture.root, 'state', id, 'candidate-worktrees'),
      maxFiles: 4, maxBytes: 10_000, maxDiffBytes: 10_000,
    })
    await manager.initialize()
    const signal = new AbortController().signal
    const handle = await manager.create(roundFixture({
      workspaceRoot: fixture.root, targetHarnessRef: fixture.championRef,
      targetHarnessDigest: fixture.manifest.digest,
    }), signal)
    try {
      await writeFile(join(handle.targetPath, path), source ?? `import ${JSON.stringify(specifier)}\n`)
      const builder = new HarnessBuilder({
        repositoryPath: fixture.repository, targetRoot: fixture.targetRoot, dshBaseRef: fixture.baseRef,
        toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
        ...(allowedImports === undefined ? {} : { allowedImports }),
      })
      if (accepted) await expect(builder.checkWorkspace(handle, signal)).resolves.toBeUndefined()
      else await expect(builder.checkWorkspace(handle, signal)).rejects.toThrow(
        `import is outside the fixed dependency allowlist in ${path}: ${specifier}`,
      )
    } finally {
      await manager.dispose(handle.workspaceId)
    }
  })
})

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

  it('verifies commit, root tree, manifest, and immutable candidate ref as one sealed identity', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot, dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    const immutableRef = 'refs/dsh-refine/evolutions/evo-1/candidates/test'
    gitOutput(fixture.repository, ['update-ref', immutableRef, fixture.championRef])
    const treeOid = gitOutput(fixture.repository, ['rev-parse', `${fixture.championRef}^{tree}`])
    const version = {
      commitOid: fixture.championRef,
      treeOid,
      manifestDigest: fixture.manifest.digest,
      patchDigest: `sha256:${'1'.repeat(64)}`,
      immutableRef,
    }
    await expect(builder.verifySealedCandidate(version)).resolves.toBeUndefined()
    await expect(builder.verifySealedCandidate({ ...version, treeOid: 'f'.repeat(40) })).rejects.toThrow(/tree OID/)
  })
})
