import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HarnessBuilder } from '../../src/harness/builder.js'
import { SubprocessHarnessCompiler } from '../../src/harness/compiler.js'
import { acquireAirGappedSandbox } from '../../src/sandbox.js'
import { documentedHarnessCandidate, documentedSkillCandidate } from '../helpers/documented-skill-candidate.js'
import { packagedTargetSkillSmoke } from '../helpers/packaged-target-skill-smoke.js'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const runtimeRoot = process.env.GEAR_TEST_DSH_RUNTIME_ROOT
const sandboxMode = process.env.GEAR_TEST_RUNTIME_SANDBOX === 'required' ? 'required' : 'disabled'

describe.skipIf(runtimeRoot === undefined)('fixed Target DSH rc.2 runtime check', () => {
  it.each(['valid', 'full harness', 'model context', 'direct dependency', 'session cwd', 'throws', 'missing dependency', 'transitive dependency', 'missing injection', 'wrong directory',
    'prompt variable', 'context throws', 'tool parameters', 'invalid frontmatter', 'read blocked', 'cleanup throws', 'cleanup timeout', 'network request', 'no skills', 'invocation disabled', 'changed after check', 'no-op'])(
    'reports actual coverage and leaves the candidate unchanged: %s', async variant => {
      const lab = await mkdtemp(join(tmpdir(), 'gear-runtime-test-'))
      const repository = join(lab, 'target')
      const lease = sandboxMode === 'required' ? await acquireAirGappedSandbox('bubblewrap-only', 'runtime-check test') : undefined
      let manager: CandidateWorkspaceManager | undefined
      let id: string | undefined
      try {
        const { stdout } = await execute(process.execPath, [join(root, 'examples/dsh-codex-luna/bootstrap-target.mjs'), repository], {
          env: { ...process.env, GEAR_LAB_ROOT: lab, GEAR_SKIP_TARGET_INSTALL: '1' },
        })
        const metadata = JSON.parse(stdout)
        manager = new CandidateWorkspaceManager({ repositoryPath: repository, targetRoot: 'harness',
          rootForEvolution: () => join(lab, 'worktrees'), maxFiles: 20, maxBytes: 100_000, maxDiffBytes: 100_000 })
        await manager.initialize()
        const handle = await manager.create({ evolutionId: 'evo', roundId: 'round',
          parentHarnessRef: metadata.initialChampion.ref, parentHarnessDigest: metadata.initialChampion.manifestDigest }, new AbortController().signal)
        id = handle.workspaceId
        manager.bind(id, 'meta')
        const files = await (variant === 'full harness' ? documentedHarnessCandidate() : documentedSkillCandidate())
        const addPlugin = (source: string) => {
          files['preset/agent.cordis.yml'] = '- id: runtime-fixture\n  name: ../plugins/runtime-fixture.js\n'
          files['plugins/runtime-fixture.js'] = source
        }
        if (variant === 'throws') addPlugin('export function apply() { throw new Error("INITIALIZATION_SENTINEL") }\n')
        if (variant === 'missing dependency') addPlugin('import "@deepseek-ai/missing-runtime-fixture"; export function apply() {}\n')
        if (variant === 'transitive dependency') addPlugin('import "@deepseek-ai/dsh-skill-filesystem"; export function apply() {}\n')
        if (variant === 'direct dependency') addPlugin('import Include from "@deepseek-ai/cordis-plugin-include"; export function apply() { if (!Include) throw new Error("DIRECT_DEPENDENCY_MISSING") }\n')
        if (variant === 'missing injection') addPlugin('export const inject = ["missingGearService"]; export function apply() {}\n')
        if (variant === 'network request') addPlugin('export async function apply() { await fetch("https://example.invalid/") }\n')
        if (variant === 'model context') addPlugin(`export const inject = ['systemPrompt']; export function apply(ctx) {
          ctx.systemPrompt.section({ name: 'selected-model', order: 50, text: 'Selected: {{provider}}/{{model}}' })
          ctx.systemPrompt.context({ name: 'real-agent-scope', order: 50, text: ({ agent, scope }) => {
            if (!agent || scope !== agent || agent.session.header.cwd !== process.cwd()) throw new Error('ASSEMBLY_SCOPE_MISMATCH')
            return 'Valid scoped context'
          } })
        }`)
        if (variant === 'prompt variable') addPlugin(`export const inject = ['systemPrompt']; export function apply(ctx) {
          ctx.systemPrompt.section({ name: 'broken-prompt', order: 50, text: '{{gear_missing_variable}}' })
        }`)
        if (variant === 'context throws') addPlugin(`export const inject = ['systemPrompt']; export function apply(ctx) {
          ctx.systemPrompt.context({ name: 'broken-context', order: 50, text: () => { throw new Error('CONTEXT_SENTINEL') } })
        }`)
        if (variant === 'tool parameters') addPlugin(`export const inject = ['tools']; export function apply(ctx) {
          ctx.tools.register({ name: 'broken_tool', description: 'Invalid lazy schema',
            output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
            execute: () => 'unused' })
        }`)
        if (variant === 'wrong directory') {
          files['skills/group/verify-change/SKILL.md'] = files['skills/verify-change/SKILL.md']!
          delete files['skills/verify-change/SKILL.md']
        }
        if (variant === 'invalid frontmatter') files['skills/verify-change/SKILL.md'] = '# No frontmatter\n'
        if (variant === 'no skills') delete files['skills/verify-change/SKILL.md']
        if (variant === 'invocation disabled') files['skills/verify-change/SKILL.md'] = files['skills/verify-change/SKILL.md']!.replace('name: verify-change', 'disable-model-invocation: true\nname: verify-change')
        if (variant === 'session cwd') addPlugin(`export const inject = ['tools']; export function apply(ctx) {
          ctx.on('tools/pre-execute', (exec, next) => {
            if (exec.name === 'skill' && (!exec.agent || exec.agent.session.header.cwd !== process.cwd()
              || exec.agent.session.header.cwd === process.env.DSH_REFINE_REPOSITORY)) {
              return { kind: 'deny', reason: 'REAL_SESSION_CWD_REQUIRED' }
            }
            return next()
          })
        }`)
        if (variant === 'read blocked') addPlugin('export const inject=["tools"]; export function apply(ctx) { ctx.on("tools/pre-execute", (exec, next) => exec.name === "skill" ? { kind: "deny", reason: "READ_SENTINEL" } : next()) }\n')
        if (variant === 'cleanup throws') addPlugin('export function apply(ctx) { ctx.effect(() => () => { throw new Error("DISPOSE_SENTINEL") }) }\n')
        if (variant === 'cleanup timeout') addPlugin('export function apply(ctx) { ctx.effect(() => () => new Promise(() => {})) }\n')
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(handle.targetPath, path)), { recursive: true })
          await writeFile(join(handle.targetPath, path), content)
        }
        const before = await manager.preflight(id)
        const manifest = await readFile(join(handle.targetPath, 'manifest.json'), 'utf8')
        const compiler = new SubprocessHarnessCompiler({
          command: variant === 'no-op' ? '/usr/bin/true' : process.execPath,
          args: variant === 'no-op' ? [] : [join(root, 'assets/dsh-runtime-check.mjs')],
          reportProtocol: 'gear-runtime-check-v1', runtimeRoot: runtimeRoot!, timeoutMs: 20_000,
          sandboxMode, linuxIsolation: 'bubblewrap-only',
          readPaths: process.platform === 'darwin' ? ['/opt/homebrew/opt', '/opt/homebrew/Cellar', '/opt/homebrew/etc/openssl@3'] : [],
        })
        const builder = new HarnessBuilder({ repositoryPath: repository, targetRoot: 'harness', dshBaseRef: metadata.dshBaseRef,
          toolchainRef: 'dsh-rc2-codex-pnpm-11.7.0', sandboxProfileRef: 'harbor-terminal-bench-2.0', compiler })
        const service = { activeEntryForSession: () => ({ workspace: handle, parentHarnessRef: handle.parentRef,
          parentHarnessDigest: handle.parentDigest, evolutionId: 'evo', roundId: 'round' }), workspaceManager: manager }
        const capabilities = new RefineCapabilities(service as never, builder)
        const result = await capabilities.call('refine-meta', 'meta', 'candidate.check', { check: 'compiler' }) as any
        if (['valid', 'full harness', 'model context', 'direct dependency', 'session cwd', 'changed after check'].includes(variant)) {
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, runtime: {
            load: { status: 'passed' }, promptAssembly: { status: 'passed' }, skillDiscovery: { status: 'passed', checked: 1 },
            skillRead: { status: 'passed', checked: 1 }, cleanup: { status: 'passed' },
            identity: { version: '0.1.1-rc.2' },
          } })
          expect(result.runtime.skills).toEqual([expect.objectContaining({ name: 'verify-change', provider: 'filesystem', read: 'passed' })])
        } else if (variant === 'no skills') {
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, runtime: {
            load: { status: 'passed' }, skillDiscovery: { status: 'not_checked', code: 'NO_CANDIDATE_SKILLS' },
            skillRead: { status: 'not_checked', checked: 0 }, cleanup: { status: 'passed' },
          } })
        } else if (variant === 'invocation disabled') {
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, runtime: {
            load: { status: 'passed' }, promptAssembly: { status: 'passed' }, skillDiscovery: { status: 'passed', checked: 1 },
            skillRead: { status: 'not_checked', code: 'MODEL_INVOCATION_DISABLED' },
          } })
        } else {
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false })
          if (['throws', 'missing dependency', 'transitive dependency', 'missing injection', 'network request'].includes(variant)) expect(result.runtime.load.status, JSON.stringify(result)).toBe('failed')
          if (['throws', 'missing dependency', 'transitive dependency', 'missing injection'].includes(variant)) {
            expect(result.runtime.cleanup.status, JSON.stringify(result)).toBe('passed')
          }
          if (['wrong directory', 'invalid frontmatter'].includes(variant)) {
            expect(result.runtime.load.status, JSON.stringify(result)).toBe('passed')
            expect(result.runtime.skillDiscovery.status, JSON.stringify(result)).toBe('failed')
          }
          if (['prompt variable', 'context throws', 'tool parameters'].includes(variant)) expect(result.runtime.promptAssembly.status, JSON.stringify(result)).toBe('failed')
          if (variant === 'read blocked') expect(result.runtime.skillRead.status, JSON.stringify(result)).toBe('failed')
          if (variant.startsWith('cleanup')) expect(result.runtime.cleanup.status, JSON.stringify(result)).toBe('failed')
        }
        expect(await manager.preflight(id)).toEqual(before)
        expect(await readFile(join(handle.targetPath, 'manifest.json'), 'utf8')).toBe(manifest)
        if (['valid', 'full harness', 'model context', 'direct dependency', 'session cwd', 'changed after check'].includes(variant)) {
          if (variant === 'changed after check') await writeFile(join(handle.targetPath, 'plugins/policy.js'),
            'export function apply() { throw new Error("EDITED_AFTER_CHECK") }\n')
          const sealed = await manager.seal(id, new AbortController().signal)
          manager.markFinalizing(id)
          const finalization = builder.finalizeWorkspace(handle, sealed, new AbortController().signal)
          if (variant === 'changed after check') await expect(finalization).rejects.toThrow('EDITED_AFTER_CHECK')
          else {
            const prepared = await finalization
            expect(prepared.validation?.runtime.candidateDigest).toBe(prepared.manifest.digest)
            expect(prepared.validation?.runtime.skillRead).toMatchObject({ status: 'passed', checked: 1 })
            if (['valid', 'full harness'].includes(variant)) await packagedTargetSkillSmoke(lab, repository, prepared.ref,
              prepared.manifest.digest, runtimeRoot!, files['skills/verify-change/SKILL.md']!, variant === 'full harness')
          }
        }
      } finally {
        if (manager && id) await manager.dispose(id)
        await rm(lab, { recursive: true, force: true })
        await lease?.release()
      }
    }, 90_000,
  )
})
