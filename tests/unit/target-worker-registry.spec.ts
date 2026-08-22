import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js'
import { RefineStateStore } from '../../src/state/store.js'
import { TargetWorkerRegistry } from '../../src/worker/registry.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('TargetWorkerRegistry', () => {
  it('launches only accepted exact commits and forwards worker notifications', async () => {
    const fixture = await createGitHarnessFixture()
    roots.push(fixture.root)
    const store = new RefineStateStore(`${fixture.root}/state`)
    await store.initialize()
    await store.writeChampion({
      schemaVersion: 2, ref: fixture.championRef, manifestDigest: fixture.manifest.digest, updatedAt: 'now',
    })
    const builder = new HarnessBuilder({
      repositoryPath: fixture.repository,
      targetRoot: fixture.targetRoot,
      dshBaseRef: fixture.baseRef,
      toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler(),
    })
    await builder.initialize()
    const script = join(fixture.root, 'fake-worker.mjs')
    await writeFile(script, `
import readline from 'node:readline'
const [ref, digest, sandbox] = process.argv.slice(2)
const lines = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {
    targetHarnessRef: ref, targetManifestDigest: digest, sandboxProfileRef: sandbox,
  } })
  else if (frame.method === 'session/open') {
    send({ jsonrpc: '2.0', id: frame.id, result: { opened: true } })
    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: frame.params.sessionId, event: { type: 'test' } } })
  } else if (frame.method === 'session/close') send({ jsonrpc: '2.0', id: frame.id, result: { closed: true } })
  else if (frame.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} })
    setImmediate(() => process.exit(0))
  }
})
`)
    const events: Record<string, unknown>[] = []
    const refine = { registry: {
      stateStore: () => store,
      readPublished: async () => ({
        schemaVersion: 1 as const, ref: fixture.championRef, manifestDigest: fixture.manifest.digest,
        publishedAt: 'now', sourceEvolutionId: 'evo-1',
      }),
    } }
    const registry = new TargetWorkerRegistry(refine as never, builder)
    const manager = await registry.createForEvolution('evo-1', {
      workerId: 'worker-1',
      command: process.execPath,
      args: [script, fixture.championRef, fixture.manifest.digest, 'sandbox-v1'],
      cwd: fixture.root,
      env: {},
      sandboxProfileRef: 'sandbox-v1',
      provider: 'test',
      model: 'test',
      onSessionEvent: event => events.push(event),
    })
    await manager.open('session-1', 'create')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    expect(events).toContainEqual(expect.objectContaining({ sessionId: 'session-1' }))
    await manager.closeSession('session-1')
    const published = await registry.createCurrent({
      workerId: 'worker-published', command: process.execPath,
      args: [script, fixture.championRef, fixture.manifest.digest, 'sandbox-v1'],
      cwd: fixture.root, env: {}, sandboxProfileRef: 'sandbox-v1', provider: 'test', model: 'test',
    })
    expect(published.launch.targetHarnessRef).toBe(fixture.championRef)
    await expect(registry.create('evo-1', {
      workerId: 'bad', command: process.execPath, args: [], cwd: fixture.root, env: {},
      targetHarnessRef: 'f'.repeat(40), targetManifestDigest: fixture.manifest.digest,
      sandboxProfileRef: 'sandbox-v1', provider: 'test', model: 'test',
    })).rejects.toThrow(/neither champion nor an accepted/)
    await registry.dispose()
  })
})
