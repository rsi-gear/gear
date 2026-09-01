import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { SkillCandidateFiles } from '../../src/skill/files.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('SkillCandidateFiles', () => {
  it('provides observed, candidate-scoped text edits without exposing fixed substrate', async () => {
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
