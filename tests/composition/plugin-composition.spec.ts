import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as refine from '../../src/index.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('published plugin composition', () => {
  it('loads named exports through a real cordis.yml Loader composition', async () => {
    const fixture = await createGitHarnessFixture()
    root = fixture.root
    const commands: Array<{ name: string }> = []
    const tools: Array<{ name: string }> = []
    let skillProvider: {
      list(options: { signal?: AbortSignal }): Promise<unknown>
      get(candidate: unknown, options: { signal?: AbortSignal }): Promise<unknown>
    } | undefined
    const metaPresetPath = join(root, 'meta-preset', 'agent.cordis.yml')
    await mkdir(join(root, 'meta-preset'), { recursive: true })
    await writeFile(metaPresetPath, '[]\n')
    const hitchExecutable = join(root, 'fake-hitch.mjs')
    await writeFile(hitchExecutable, `#!/usr/bin/env node
if (process.argv[2] === '--version') console.log('0.2.7')
else if (process.argv[2] === 'capabilities') console.log(JSON.stringify({
  schema_version: '1', trajectory_analysis: '1', trajectory_events_page: '1', verifier_evidence: '1',
}))
else process.exitCode = 2
`)
    await chmod(hitchExecutable, 0o755)
    const fakeServices = {
      name: 'refine-test-services',
      apply(ctx: Context) {
        ctx.provide('agents', {
          get: () => undefined,
          create: async () => { throw new Error('not used') },
          resume: async () => { throw new Error('not used') },
        } as never)
        ctx.provide('sessions', { flush: async () => true } as never)
        ctx.provide('agentPresets', {
          mount: async () => ({ id: 'refine-meta' }),
          resolve: async () => ({ id: 'refine-meta', path: metaPresetPath, trust: 'system' }),
        } as never)
        ctx.provide('commands', {
          register(definition: { name: string }) { commands.push(definition); return () => {} },
        } as never)
        ctx.provide('tools', {
          register(definition: { name: string }) { tools.push(definition); return () => {} },
        } as never)
        ctx.provide('skills', {
          registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => typeof skillProvider) {
            skillProvider = create({ signal: new AbortController().signal, invalidate() {} })
            return () => {}
          },
        } as never)
        ctx.provide('systemPrompt', {} as never)
        ctx.provide('subprocess', {} as never)
        ctx.provide('shellEnv', {} as never)
      },
    }
    const configPath = join(root, 'agent.cordis.yml')
    const socketPath = join('/private/tmp', `gear-refine-composition-${process.pid}-${Date.now()}.sock`)
    const q = (value: string): string => JSON.stringify(value)
    await writeFile(configPath, [
      '- name: refine-test-services',
      '- name: rsi-gear',
      '  config:',
      `    workspaceRoot: ${q(root)}`,
      `    dshRepository: ${q(fixture.repository)}`,
      `    targetRoot: ${q(fixture.targetRoot)}`,
      '    metaAdapter:',
      `      socketPath: ${q(socketPath)}`,
      '    metaModel:',
      '      provider: test',
      '      model: test-model',
      '    metaSampling:',
      '      reasoningEffort: medium',
      `    dshBaseRef: ${fixture.baseRef}`,
      '    toolchainRef: node-22-tsc',
      '    sandboxProfileRef: sandbox-v1',
      '    metaSandbox:',
      '      mode: disabled',
      '    candidateWorkspace:',
      '      shellEnabled: false',
      '    seedTaskRef: seed-commit',
      '    heldOutRef: held-out-commit',
      '    compiler:',
      `      command: ${q(process.execPath)}`,
      '      args: ["-e", "process.exit(0)"]',
      '      env: {}',
      '    hitch:',
      `      executable: ${q(hitchExecutable)}`,
      '      model: test-rollout-model',
      '    initialChampion:',
      '      schemaVersion: 2',
      `      ref: ${fixture.championRef}`,
      `      manifestDigest: ${fixture.manifest.digest}`,
      '      updatedAt: now',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['refine-test-services', fakeServices],
      ['rsi-gear', refine],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
        return modules.get(specifier)
      },
    } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect(context.refine).toBeDefined()
    expect(context.notebookRuntime).toBeDefined()
    expect(context.targetWorkers).toBeDefined()
    expect(context.evolutionComponents).toBeDefined()
    expect(context.refine.options.rollout.seeds).toBeUndefined()
    expect(context.refine.options.metaAgent.sampling).toEqual({ reasoningEffort: 'medium' })
    expect(context.refine.options.metaAgent.runtime.type).toBe('dsh')
    expect(context.refine.options.metaAgent.preset.id).toBe('refine')
    expect(context.refine.options.metaAgent.preset.resources.map(value => value.logicalPath)).toEqual([
      'SKILL.md', 'agents/openai.yaml', 'references/dsh-target-harness.md',
      'references/protocol.md', 'references/target-harness-editing.md',
      'scripts/transport.mjs',
    ])
    expect(context.refine.options.metaAgent.preset.digest).not.toBe(context.refine.options.metaAgent.preset.resources[0]?.digest)
    expect(commands).toEqual([])
    expect(tools).toContainEqual(expect.objectContaining({ name: 'refine_request' }))
    expect(skillProvider).toBeDefined()
    const candidates = await skillProvider!.list({}) as Array<{ name: string; rank: number }>
    expect(candidates).toContainEqual(expect.objectContaining({ name: 'refine', rank: 0 }))
    const skill = await skillProvider!.get(candidates[0], {}) as { content: string; resourceBase: { kind: string } }
    expect(skill.content).toContain('Use Gear as the authority for evolution state')
    expect(skill.resourceBase.kind).toBe('directory')
  })
})
