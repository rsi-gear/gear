import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as gear from '../../src/index.js'
import { initProject } from '../../src/application/init.js'

let context: Context | undefined, root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose(); context = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('published project plugin composition', () => {
  it('loads a thin DSH adapter through the real Cordis loader and calls the shared application', async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-native-'))
    const project = join(root, 'project'); await initProject(project)
    const commands: Array<{ name: string; handler(input: { rawInput: string }): Promise<{ kind: string; text: string }> }> = []
    const tools: Array<{ name: string; execute(args: unknown, exec: unknown): Promise<unknown> }> = []
    let provider: { list(): Promise<Array<{ name: string }>>; get(): Promise<{ content: string }> } | undefined
    const services = { name: 'project-test-services', apply(ctx: Context) {
      ctx.provide('commands', { register(value: typeof commands[number]) { commands.push(value); return () => {} } } as never)
      ctx.provide('tools', { register(value: typeof tools[number]) { tools.push(value); return () => {} } } as never)
      ctx.provide('skills', { registerProvider(create: () => typeof provider) { provider = create(); return () => {} } } as never)
    } }
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, '- name: project-test-services\n- name: rsi-gear\n  config:\n    projectRoot: ' + JSON.stringify(project) + '\n    socketPath: ' + JSON.stringify(join(root, 's.sock')) + '\n')
    context = new Context(); context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader); context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['project-test-services', services], ['rsi-gear', gear]])
    context.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`Unexpected import: ${name}`)
      return modules.get(name)
    } } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect(context.gear).toBeInstanceOf(gear.ProjectController)
    expect(context.gear.application.root).toBe(project)
    expect(gear).not.toHaveProperty('RefineService')
    expect(gear).not.toHaveProperty('ComponentRegistry')
    expect(commands.map(command => command.name)).toEqual(['gear'])
    expect(await provider!.list()).toContainEqual(expect.objectContaining({ name: 'refine' }))
    expect((await provider!.get()).content).toContain('run.refine')
    const tool = tools.find(tool => tool.name === 'refine_request')!
    const result = await tool.execute({ method: 'config.explain', params: {} }, {
      agent: { id: 'operator' }, callId: 'config-call', signal: new AbortController().signal,
    })
    expect(result).toEqual(await context.gear.invoke('config.explain'))
    const reply = await commands[0]!.handler({ rawInput: 'config explain' })
    expect(reply.kind).toBe('success')
    expect(JSON.parse(reply.text)).toEqual(result)
  })
})
