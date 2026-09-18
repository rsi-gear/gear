import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { buildGrepCommand, parseGrepMatches, resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateFileSystem } from '../../src/candidate/filesystem.js'
import { CandidateSearchSubprocess } from '../../src/candidate/subprocess.js'
import { CandidateShellExecutor } from '../../src/candidate/shell.js'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { isolateCandidateProviderContext } from '../../src/candidate/context.js'
import type { RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { roundFixture } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, ref: string, digest: string, roundId: string): RefinementRound {
  return roundFixture({ roundId, workspaceRoot: root, targetHarnessRef: ref, targetHarnessDigest: digest, taskBudgetMs: 1_000 })
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
  it('can read and edit the ./ paths returned by the native grep tool', async () => {
    const { manager, handle } = await setup()
    try {
      const output = execFileSync(await resolveRgPath(), ['--no-config', ...buildGrepCommand({ pattern: 'value', path: '.' })], {
        cwd: handle.targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
      const [match] = parseGrepMatches(output)
      expect(match?.path).toBe('./plugins/context.ts')
      const fs = new CandidateFileSystem(new Context(), manager, 'meta-1', 1_024)
      const target = await fs.resolve(match!.path)
      expect(await fs.readText(target)).toBe('export const value = 1\n')
      await fs.editText(target, { oldString: 'value = 1', newString: 'value = 2', replaceAll: false })
      expect(await fs.readText(target)).toBe('export const value = 2\n')
      await expect(fs.resolve('./plugins/../../package.json')).rejects.toThrow(/traverse/)
      await expect(fs.resolve('./manifest.json')).rejects.toThrow(/fixed substrate|protected/)
    } finally {
      manager.unbind('meta-1', handle.workspaceId)
      await manager.dispose(handle.workspaceId)
    }
  })

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
    search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--json', '--regexp=needle', '--', '/candidate/harness/prompts'], cwd: '/', env: {} } as unknown as SubprocessSpawnSpec)
    expect(captured?.argv.at(-1)).toBe('prompts')
    expect(() => search.spawn({ argv: ['/bin/sh', '--no-config'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/fixed ripgrep/)
    expect(() => search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--', '../state'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/relative/)
    expect(() => search.spawn({ argv: ['/opt/tool/rg', '--no-config', '--follow'], cwd: handle.targetPath } as unknown as SubprocessSpawnSpec)).toThrow(/fixed ripgrep/)
    manager.unbind('meta-1', handle.workspaceId)
    await manager.dispose(handle.workspaceId)
  })

  it('accepts DSH-normalized candidate shell workdirs without admitting other host paths', async () => {
    const { fixture, manager, handle } = await setup()
    const shell = new CandidateShellExecutor(new Context(), manager, 'meta-1', 1_000, 1_024)
    expect(shell.resolve({ command: 'pwd', workdir: '/candidate/harness' }).workdir).toBe(handle.targetPath)
    expect(shell.resolve({ command: 'pwd', workdir: join(handle.targetPath, 'prompts') }).workdir)
      .toBe(join(handle.targetPath, 'prompts'))
    expect(() => shell.resolve({ command: 'pwd', workdir: fixture.root })).toThrow(/absolute host path/)
    manager.unbind('meta-1', handle.workspaceId)
    await manager.dispose(handle.workspaceId)
  })
})
