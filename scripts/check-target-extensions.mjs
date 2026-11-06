import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DshHarnessAdapter } from '../lib/adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../lib/adapters/pi/harness.js'

const dshPackage = process.env.GEAR_TEST_DSH_PACKAGE
const piPackage = process.env.GEAR_TEST_PI_PACKAGE
if (!dshPackage || !piPackage) throw new Error('Set GEAR_TEST_DSH_PACKAGE and GEAR_TEST_PI_PACKAGE to the installed runtime package.json files')
const root = await mkdtemp(join(tmpdir(), 'gear-target-extensions-'))
const marker = 'GEAR_EXTENSION_OBSERVED'
try {
  const dsh = createRequire(resolve(dshPackage)), target = join(root, 'dsh')
  const native = name => import(pathToFileURL(dsh.resolve(name)).href)
  const [{ Context }, { default: SystemPrompt, renderPrompt }, { default: Loader }, { default: Include }] =
    await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include'].map(native))
  await new DshHarnessAdapter().prepare(target)
  const assemble = async () => {
    const context = new Context()
    try {
      context.baseUrl = pathToFileURL(target).href + '/'
      await context.plugin(SystemPrompt); await context.plugin(Loader)
      context.loader.builtins.include = Include
      await context.loader.create({ name: 'cordis:include', config: { path: './preset/agent.cordis.yml' } })
      await context.loader.await()
      return renderPrompt(await context.systemPrompt.assemble())
    } finally { await context.fiber.dispose() }
  }
  assert.ok(!(await assemble()).includes(marker))
  await writeFile(join(target, 'prompts/system.md'), marker)
  assert.ok((await assemble()).endsWith(marker), 'The native DSH plugin must read the changed prompt resource')
  const piRoot = resolve(piPackage, '..'), piTarget = join(root, 'pi')
  await new PiHarnessAdapter().prepare(piTarget)
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href)
  const { ExtensionRunner } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/runner.js')).href)
  const { SessionManager } = await import(pathToFileURL(join(piRoot, 'dist/core/session-manager.js')).href)
  const invoke = async paths => {
    const loaded = await loadExtensions(paths, piTarget)
    assert.deepEqual(loaded.errors, [])
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, piTarget, SessionManager.inMemory(piTarget), undefined)
    const errors = []; runner.onError(error => errors.push(error))
    const value = await runner.emitBeforeAgentStart('fixture', undefined, 'base', { cwd: piTarget })
    assert.deepEqual(errors, [])
    return value?.systemPrompt ?? 'base'
  }
  assert.equal(await invoke([]), 'base')
  const extension = join(piTarget, '.pi/extensions/policy.ts')
  await writeFile(extension, `export default function(pi) { pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\\n${marker}' })) }`)
  assert.equal(await invoke([extension]), 'base\n' + marker)
  console.log(JSON.stringify({ dsh: { version: JSON.parse(await readFile(dshPackage, 'utf8')).version, plugin_behavior: 'passed' },
    pi: { version: JSON.parse(await readFile(piPackage, 'utf8')).version, extension_behavior: 'passed' }, model_calls: 0 }))
} finally { await rm(root, { recursive: true, force: true }) }
