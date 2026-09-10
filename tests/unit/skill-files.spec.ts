import { chmod, mkdir, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { SkillCandidateFiles } from '../../src/skill/files.js'
import { RefineSkillGateway } from '../../src/skill/gateway.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const manager = new CandidateWorkspaceManager({
    repositoryPath: fixture.repository,
    targetRoot: fixture.targetRoot,
    rootForEvolution: () => join(fixture.root, 'state', 'candidate-worktrees'),
    maxFiles: 64,
    maxBytes: 2_000_000,
    maxDiffBytes: 1_000_000,
  })
  await manager.initialize()
  const workspace = await manager.create({
    evolutionId: 'evo-1', roundId: 'round-1',
    parentHarnessRef: fixture.championRef, parentHarnessDigest: fixture.manifest.digest,
  }, new AbortController().signal)
  manager.bind(workspace.workspaceId, 'meta-1')
  const files = new SkillCandidateFiles(manager, { maxReadBytes: 128 * 1024 })
  return { fixture, manager, workspace, files }
}

describe('SkillCandidateFiles', () => {
  it('lets the gateway create and clear empty text files while retaining observation checks', async () => {
    const { manager, workspace, files } = await setup()
    const gateway = new RefineSkillGateway({} as never, {
      authorize: () => ({ sessionId: 'meta-1' }),
    } as never, {} as never, files)
    const lease = { clientId: 'client', leaseId: 'lease', leaseToken: 'token' }
    try {
      const path = 'skills/check/scripts/__init__.py'
      await gateway.call('candidate.write', { ...lease, path, text: '', expectedDigest: null })
      const empty = await files.read('meta-1', path)
      expect(empty).toMatchObject({ text: '', bytes: 0 })
      await expect(gateway.call('candidate.write', { ...lease, path, text: '', expectedDigest: null })).rejects.toThrow(/changed/)
      const written = await files.write('meta-1', path, 'before\n', empty.digest)
      await gateway.call('candidate.write', { ...lease, path, text: '', expectedDigest: written.digest })
      expect(await files.read('meta-1', path)).toEqual(empty)
      await expect(gateway.call('candidate.write', { ...lease, path, expectedDigest: empty.digest })).rejects.toThrow(/text/)
    } finally {
      await manager.dispose(workspace.workspaceId)
    }
  })

  it.each([false, true])('preserves literal replacement text with replaceAll=%s', async replaceAll => {
    const { manager, workspace, files } = await setup()
    try {
      const path = 'plugins/policy.js'
      const original = await files.write('meta-1', path, 'prefix OLD suffix', null)
      const replacement = '$& $$ $` $\' $1'
      const result = await files.edit('meta-1', path, 'OLD', replacement, original.digest, replaceAll)
      expect((await files.read('meta-1', path)).text).toBe(`prefix ${replacement} suffix`)
      expect(result.replacements).toBe(1)
    } finally {
      await manager.dispose(workspace.workspaceId)
    }
  })

  it('retains executable script permissions after both write and edit', async () => {
    const { manager, workspace, files } = await setup()
    try {
      const path = 'skills/check/scripts/check.sh'
      const original = await files.write('meta-1', path, '#!/bin/sh\necho before\n', null)
      await chmod(join(workspace.targetPath, path), 0o755)
      const edited = await files.edit('meta-1', path, 'before', 'after', original.digest)
      expect((await stat(join(workspace.targetPath, path))).mode & 0o777).toBe(0o755)
      await files.write('meta-1', path, '#!/bin/sh\necho rewritten\n', edited.digest)
      expect((await stat(join(workspace.targetPath, path))).mode & 0o777).toBe(0o755)
    } finally {
      await manager.dispose(workspace.workspaceId)
    }
  })

  it('accepts leading ./ paths without permitting parent traversal or protected files', async () => {
    const { manager, workspace, files } = await setup()
    try {
      expect(await files.read('meta-1', './plugins/context.ts')).toEqual(await files.read('meta-1', 'plugins/context.ts'))
      expect(await files.tree('meta-1', './')).toEqual(await files.tree('meta-1'))
      await expect(files.read('meta-1', './plugins/../../package.json')).rejects.toThrow(/normalized/)
      await expect(files.read('meta-1', './manifest.json')).rejects.toThrow(/fixed substrate|protected/)
    } finally {
      await manager.dispose(workspace.workspaceId)
    }
  })

  it('provides observed, candidate-scoped text edits without exposing fixed substrate', async () => {
    const { manager, workspace, files } = await setup()

    const tree = await files.tree('meta-1')
    expect(tree.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
      '/candidate/harness/plugins',
      '/candidate/harness/plugins/context.ts',
      '/candidate/harness/preset',
    ]))
    expect(tree.entries.some(entry => entry.path.includes('manifest.json'))).toBe(false)

    const observed = await files.read('meta-1', 'plugins/context.ts')
    expect(observed.text).toBe('export const value = 1\n')
    const edited = await files.edit(
      'meta-1', 'plugins/context.ts', 'value = 1', 'value = 2', observed.digest,
    )
    expect((await files.read('meta-1', 'plugins/context.ts')).text).toContain('value = 2')
    await expect(files.edit('meta-1', 'plugins/context.ts', 'value = 2', 'value = 3', observed.digest)).rejects.toThrow(/changed/)

    const created = await files.write('meta-1', 'prompts/new.md', 'new prompt\n', null)
    expect(created.digest).toMatch(/^sha256:/)
    await expect(files.write('meta-1', 'prompts/new.md', 'overwrite\n', null)).rejects.toThrow(/changed/)
    await expect(files.read('meta-1', '../manifest.json')).rejects.toThrow(/normalized/)
    await expect(files.read('meta-1', 'manifest.json')).rejects.toThrow(/fixed substrate|protected/)
    await expect(files.write('meta-1', 'package.json', '{}', null)).rejects.toThrow(/fixed substrate|protected/)

    await mkdir(join(workspace.targetPath, 'skills'), { recursive: true })
    const escape = join(workspace.targetPath, 'skills', 'escape')
    await symlink('/tmp', escape)
    await expect(files.read('meta-1', 'skills/escape/secret')).rejects.toThrow(/links/)
    await rm(escape)

    expect(await files.remove('meta-1', 'prompts/new.md', created.digest)).toEqual({
      path: '/candidate/harness/prompts/new.md', removed: true,
    })
    expect((await manager.diff(workspace.workspaceId)).summary.files).toEqual([
      expect.objectContaining({ path: 'plugins/context.ts', change: 'modified' }),
    ])
    await manager.dispose(workspace.workspaceId)
    void edited
  })
})
