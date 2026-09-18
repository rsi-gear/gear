import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import type { RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, ref: string, digest: string): RefinementRound {
  return roundFixture({ workspaceRoot: root, targetHarnessRef: ref, targetHarnessDigest: digest, taskBudgetMs: 1_000 })
}

async function setup() {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const manager = new CandidateWorkspaceManager({
    repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    rootForEvolution: id => join(fixture.root, 'state', id, 'candidate-worktrees'),
    maxFiles: 4, maxBytes: 10_000, maxDiffBytes: 10_000,
  })
  await manager.initialize()
  const handle = await manager.create(round(fixture.root, fixture.championRef, fixture.manifest.digest), new AbortController().signal)
  return { fixture, manager, handle }
}

describe('CandidateWorkspaceManager', () => {
  it('preserves and restores an interrupted handoff workspace without rebuilding its diff', async () => {
    const { manager, handle } = await setup()
    await mkdir(join(handle.targetPath, 'prompts'), { recursive: true })
    await writeFile(join(handle.targetPath, 'prompts', 'handoff.md'), 'uncommitted work\n')
    const before = await manager.preflight(handle.workspaceId)
    const recovered = new CandidateWorkspaceManager(manager.options)
    await recovered.initialize()
    expect(await recovered.recoverOrphans(handle.evolutionId, new Set([handle.workspaceId]))).toEqual([])
    const input = { evolutionId: handle.evolutionId, roundId: handle.roundId,
      parentHarnessRef: handle.parentRef, parentHarnessDigest: handle.parentDigest }
    await expect(recovered.restore(handle.workspaceId, { ...input, parentHarnessDigest: 'changed' })).rejects.toThrow(/identity/)
    const restored = await recovered.restore(handle.workspaceId, input)
    recovered.bind(restored.workspaceId, 'successor')
    expect(restored.worktreePath).toBe(handle.worktreePath)
    expect(await recovered.preflight(restored.workspaceId)).toEqual(before)
    expect(await readFile(join(restored.targetPath, 'prompts', 'handoff.md'), 'utf8')).toBe('uncommitted work\n')
    await recovered.dispose(restored.workspaceId)
  })
  it('binds one opaque workspace to one Meta session and renders a host-path-free diff', async () => {
    const { manager, handle } = await setup()
    manager.bind(handle.workspaceId, 'meta-1')
    expect(manager.resolve('meta-1').workspaceId).toBe(handle.workspaceId)
    await mkdir(join(handle.targetPath, 'prompts'), { recursive: true })
    await writeFile(join(handle.targetPath, 'prompts', 'policy.md'), 'new policy\n')
    const diff = await manager.diff(handle.workspaceId)
    expect(diff.summary.files).toEqual([expect.objectContaining({ path: 'prompts/policy.md', change: 'created' })])
    expect(diff.patch).toContain('b/harness/prompts/policy.md')
    expect(diff.patch).not.toContain(handle.worktreePath)
    manager.unbind('meta-1', handle.workspaceId)
    expect(() => manager.resolve('meta-1')).toThrow(/no active candidate/)
    await manager.dispose(handle.workspaceId)
  })

  it('rejects changes outside targetRoot and symlink artifacts', async () => {
    const outside = await setup()
    await writeFile(join(outside.handle.worktreePath, 'outside.txt'), 'escape\n')
    await expect(outside.manager.preflight(outside.handle.workspaceId)).rejects.toThrow(/escapes target root/)
    await outside.manager.dispose(outside.handle.workspaceId)

    const linked = await setup()
    await mkdir(join(linked.handle.targetPath, 'prompts'), { recursive: true })
    await symlink('/etc/hosts', join(linked.handle.targetPath, 'prompts', 'linked.md'))
    await expect(linked.manager.preflight(linked.handle.workspaceId)).rejects.toThrow(/symlink/)
    await linked.manager.dispose(linked.handle.workspaceId)
  })

  it('detects any source replacement after sealing', async () => {
    const { manager, handle } = await setup()
    await writeFile(join(handle.targetPath, 'plugins', 'second.ts'), 'export const second = 2\n')
    const sealed = await manager.seal(handle.workspaceId)
    manager.markFinalizing(handle.workspaceId)
    await writeFile(join(handle.targetPath, 'plugins', 'second.ts'), 'export const second = 3\n')
    await expect(manager.verifySealed(handle.workspaceId, sealed)).rejects.toThrow(/changed after it was sealed/)
    await manager.dispose(handle.workspaceId)
  })

  it('allows an unrelated dirty main checkout without importing it into the detached candidate', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    await writeFile(join(fixture.repository, 'user-uncommitted.txt'), 'belongs to the user\n')
    const manager = new CandidateWorkspaceManager({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
      rootForEvolution: id => join(fixture.root, 'state', id, 'candidate-worktrees'),
      maxFiles: 4, maxBytes: 10_000, maxDiffBytes: 10_000,
    })
    await manager.initialize()
    const handle = await manager.create(round(fixture.root, fixture.championRef, fixture.manifest.digest), new AbortController().signal)
    await expect(readFile(join(handle.worktreePath, 'user-uncommitted.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(fixture.repository, 'user-uncommitted.txt'), 'utf8')).toBe('belongs to the user\n')
    await manager.dispose(handle.workspaceId)
  })

  it('rejects every session-bound operation once sealing starts', async () => {
    const { manager, handle } = await setup()
    manager.bind(handle.workspaceId, 'meta-1')
    await writeFile(join(handle.targetPath, 'plugins', 'sealed.ts'), 'export const sealed = true\n')
    await manager.seal(handle.workspaceId)
    await expect(manager.withOpenWorkspace('meta-1', true, async () => undefined)).rejects.toThrow(/does not accept operations/)
    manager.unbind('meta-1', handle.workspaceId)
    await manager.dispose(handle.workspaceId)
  })
})
