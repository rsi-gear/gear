import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateFileSystem } from '../../src/candidate/filesystem.js'
import { CandidateSearchSubprocess } from '../../src/candidate/subprocess.js'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { isolateCandidateProviderContext } from '../../src/candidate/context.js'
import type { RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, ref: string, digest: string, roundId: string): RefinementRound {
  return {
    schemaVersion: 3, evolutionId: 'evo-1', roundId, workspaceRoot: root,
    status: 'preparing-candidate', source: 'api', createdAt: 'now', updatedAt: 'now',
    metaHarnessRef: 'meta-v1', targetHarnessRef: ref, targetHarnessDigest: digest,
    sandboxProfileRef: 'sandbox-v1', seedTaskRef: 'seed', heldOutRef: 'held-out', taskBudgetMs: 1_000,
    promotionPolicy: { minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true, maxHeldOutRegression: 0, maxRequiredRegressions: 0 },
    batchId: 'batch-1', roundIndex: 1, roundCount: 1,
  }
}

async function setup() {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const manager = new CandidateWorkspaceManager({
    repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    rootForEvolution: id => join(fixture.root, 'state', id, 'candidate-worktrees'),
    maxFiles: 8, maxBytes: 1_024, maxDiffBytes: 4_096,
  })
  await manager.initialize()
  const handle = await manager.create(round(fixture.root, fixture.championRef, fixture.manifest.digest, 'round-1'), new AbortController().signal)
  manager.bind(handle.workspaceId, 'meta-1')
  return { fixture, manager, handle }
}

describe('candidate-scoped DSH providers', () => {
  it('isolates candidate provider slots from inherited control-plane services', async () => {
    const { manager, handle } = await setup()
    const parent = new Context()
    new CandidateFileSystem(parent, manager, 'meta-1', 1_024)
    const candidateCtx = isolateCandidateProviderContext(parent)
    new CandidateFileSystem(candidateCtx, manager, 'meta-1', 1_024)
    expect((parent as Context & { fs: unknown }).fs)
      .not.toBe((candidateCtx as Context & { fs: unknown }).fs)
    manager.unbind('meta-1', handle.workspaceId)
    await manager.dispose(handle.workspaceId)
  })

  it('preserves DSH filesystem operations while hiding host paths and rejecting stale/protected targets', async () => {
    const { fixture, manager, handle } = await setup()
    const fs = new CandidateFileSystem(new Context(), manager, 'meta-1', 1_024)
    const target = await fs.resolve('prompts/new.md')
    await fs.writeText(target, 'hello\n')
    expect(await fs.readText(target)).toBe('hello\n')
    expect(fs.fileUrl(target)).toBe('file:///candidate/harness/prompts/new.md')
    await expect(fs.resolve('/etc/passwd')).rejects.toThrow(/host paths/)
    await expect(fs.resolve('manifest.json')).rejects.toThrow(/fixed substrate|protected/)
    expect(() => fs.writeText(target, 'bad\0text')).toThrow(/NUL/)

    manager.unbind('meta-1', handle.workspaceId)
    const next = await manager.create(round(fixture.root, fixture.championRef, fixture.manifest.digest, 'round-2'), new AbortController().signal)
    manager.bind(next.workspaceId, 'meta-1')
    await expect(fs.readText(target)).rejects.toThrow(/stale or foreign/)
    manager.unbind('meta-1', next.workspaceId)
    await manager.dispose(next.workspaceId)
    await manager.dispose(handle.workspaceId)
  })

  it('forces fixed ripgrep searches into the active target and rejects executable/escape widening', async () => {
    const { manager, handle } = await setup()
    await mkdir(join(handle.targetPath, 'prompts'), { recursive: true })
    await writeFile(join(handle.targetPath, 'prompts', 'a.md'), 'needle\n')
    let captured: SubprocessSpawnSpec | undefined
    const upstream = {
      resolveExecutable: async (command: string) => command,
      spawn: (spec: SubprocessSpawnSpec) => { captured = spec; return {} as SubprocessHandle },
    } as unknown as SubprocessRuntime
    const search = new CandidateSearchSubprocess(new Context(), upstream, manager, 'meta-1')
    search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--json', '--regexp=needle', '--', 'prompts'], cwd: '/', env: { SECRET: 'x' } } as unknown as SubprocessSpawnSpec)
    expect(captured).toMatchObject({ cwd: handle.targetPath, env: {} })
    expect(() => search.spawn({ argv: ['/bin/sh', '--no-config'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/fixed ripgrep/)
    expect(() => search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--', '../state'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/relative/)
    expect(() => search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--follow'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/fixed ripgrep/)
    manager.unbind('meta-1', handle.workspaceId)
    await manager.dispose(handle.workspaceId)
  })
})
