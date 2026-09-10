import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HarnessBuilder } from '../../src/harness/builder.js'
import { SubprocessHarnessCompiler } from '../../src/harness/compiler.js'
import { createGitHarnessFixture } from '../../tests/helpers/git-fixture.js'
import { documentedSkillCandidate } from '../../tests/helpers/documented-skill-candidate.js'
import { roundFixture } from '../../tests/helpers/research-fixture.js'

// Legacy compiler success must not claim runtime coverage. The same negative
// candidates are exercised by the real rc.2 runtime integration suite.
it.each(['documented skill', 'initialization throws', 'missing dependency', 'wrong skill directory', 'invalid preset'])(
  'candidate.check explicitly reports unverified runtime coverage: %s', async variant => {
    const fixture = await createGitHarnessFixture()
    const manager = new CandidateWorkspaceManager({
      repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
      rootForEvolution: id => join(fixture.root, 'state', id, 'candidate-worktrees'),
      maxFiles: 10, maxBytes: 100_000, maxDiffBytes: 100_000,
    })
    let workspaceId: string | undefined
    try {
      await manager.initialize()
      const signal = new AbortController().signal
      const handle = await manager.create(roundFixture({
        workspaceRoot: fixture.root, targetHarnessRef: fixture.championRef,
        targetHarnessDigest: fixture.manifest.digest,
      }), signal)
      workspaceId = handle.workspaceId
      manager.bind(handle.workspaceId, 'repro-meta')
      const files = await documentedSkillCandidate()
      if (variant === 'invalid preset') files['preset/agent.cordis.yml'] = 'not: a-list\n'
      if (variant === 'initialization throws') files['plugins/skill-loader.js'] =
        'export function apply() { throw new Error("RUNTIME_INITIALIZATION_SENTINEL") }\n'
      if (variant === 'missing dependency') files['plugins/skill-loader.js'] =
        'import "@deepseek-ai/gear-runtime-gap-nonexistent"\nexport function apply() {}\n'
      if (['initialization throws', 'missing dependency'].includes(variant)) {
        files['preset/agent.cordis.yml'] = '- id: runtime-fixture\n  name: ../plugins/skill-loader.js\n'
      }
      if (variant === 'wrong skill directory') {
        files['skills/group/verify-change/SKILL.md'] = files['skills/verify-change/SKILL.md']!
        delete files['skills/verify-change/SKILL.md']
      }
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(handle.targetPath, path)), { recursive: true })
        await writeFile(join(handle.targetPath, path), content)
      }
      const before = await manager.preflight(handle.workspaceId, signal)
      const manifestBefore = await readFile(join(handle.targetPath, 'manifest.json'), 'utf8')
      const builder = new HarnessBuilder({
        repositoryPath: fixture.repository, targetRoot: fixture.targetRoot, dshBaseRef: fixture.baseRef,
        toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
        compiler: new SubprocessHarnessCompiler({ command: '/usr/bin/true', args: [], timeoutMs: 5_000 }),
      })
      await builder.initialize()
      const active = {
        evolutionId: handle.evolutionId, roundId: handle.roundId,
        parentHarnessRef: handle.parentRef, parentHarnessDigest: handle.parentDigest,
        workspace: handle,
      }
      // Only unrelated orchestration state is stubbed; the capability, builder,
      // Git worktree/preflight and /usr/bin/true subprocess are all real.
      const service = { activeEntryForSession: () => active, workspaceManager: manager }
      const capabilities = new RefineCapabilities(service as never, builder)
      const result = await capabilities.call('refine-meta', 'repro-meta', 'candidate.check', { check: 'compiler' })
      if (variant === 'invalid preset') expect(result).toMatchObject({ ok: false, static: { status: 'failed' }, compiler: { status: 'not_checked' } })
      else expect(result).toMatchObject({ ok: true, compiler: { ok: true }, okScope: 'configured_checks', static: { status: 'passed' }, runtime: {
        load: { status: 'not_checked', code: 'RUNTIME_VALIDATION_UNAVAILABLE' },
        skillDiscovery: { status: 'not_checked' }, skillRead: { status: 'not_checked' },
      } })
      expect(await manager.preflight(handle.workspaceId, signal)).toEqual(before)
      expect(await readFile(join(handle.targetPath, 'manifest.json'), 'utf8')).toBe(manifestBefore)
      expect(JSON.parse(manifestBefore).artifacts.some((item: { path: string }) => item.path.startsWith('skills/'))).toBe(false)
      await expect(capabilities.call('refine-meta', 'repro-meta', 'candidate.check', { check: 'runtime' }))
        .rejects.toThrow('only supports the fixed "compiler" pipeline')
    } finally {
      if (workspaceId !== undefined) await manager.dispose(workspaceId)
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
)
