import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as refine from '../../src/index.js'

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
    root = await mkdtemp(join(tmpdir(), 'refine-composition-'))
    const harness = join(root, 'champion')
    await mkdir(harness, { recursive: true })
    await writeFile(join(harness, 'manifest.json'), JSON.stringify({ schemaVersion: 1, digest: 'sha256:champion', artifacts: [] }))
    const commands: Array<{ name: string }> = []
    const metaPresetPath = join(root, 'meta-preset', 'agent.cordis.yml')
    await mkdir(join(root, 'meta-preset'), { recursive: true })
    await writeFile(metaPresetPath, '[]\n')
    const fakeServices = {
      name: 'refine-test-services',
      apply(ctx: Context) {
        ctx.provide('agents', {
          get: () => undefined,
          create: async () => { throw new Error('not used') },
          resume: async () => { throw new Error('not used') },
        } as never)
        ctx.provide('agentPresets', {
          mount: async () => ({ id: 'refine-meta' }),
          resolve: async () => ({ id: 'refine-meta', path: metaPresetPath, trust: 'system' }),
        } as never)
        ctx.provide('commands', {
          register(definition: { name: string }) { commands.push(definition); return () => {} },
        } as never)
        ctx.provide('tools', {} as never)
        ctx.provide('systemPrompt', {} as never)
      },
    }
    const configPath = join(root, 'agent.cordis.yml')
    const q = (value: string): string => JSON.stringify(value)
    await writeFile(configPath, [
      '- name: refine-test-services',
      '- name: dsh-plugin-refine',
      '  config:',
      `    workspaceRoot: ${q(root)}`,
      `    harnessRoot: ${q(join(root, 'harness-store'))}`,
      '    metaPreset: refine-meta',
      '    metaHarnessRef: meta-v1',
      '    metaModel: {}',
      '    dshRevision: rc8',
      '    toolchainRef: test-toolchain',
      '    sandboxProfileRef: sandbox-v1',
      '    seedTaskRef: seed-commit',
      '    heldOutRef: held-out-commit',
      '    compiler:',
      `      command: ${q(process.execPath)}`,
      '      args: ["-e", "process.exit(0)"]',
      '      env: {}',
      '    initialChampion:',
      '      ref: champion',
      '      digest: sha256:champion',
      `      artifactPath: ${q(harness)}`,
      '      updatedAt: now',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['refine-test-services', fakeServices],
      ['dsh-plugin-refine', refine],
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
    expect(commands).toContainEqual(expect.objectContaining({ name: 'refine' }))
  })
})
