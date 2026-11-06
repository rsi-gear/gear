import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestRefineSkill } from '../../src/adapters/skill/client.js'
import { RefineSkillServer } from '../../src/adapters/skill/server.js'

const roots: string[] = []
const servers: RefineSkillServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RefineSkillServer', () => {
  it('serves structured requests over an owner-only local socket and returns errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-skill-server-'))
    roots.push(root)
    const socketPath = join(root, 'refine.sock')
    const server = new RefineSkillServer(socketPath, {
      maxRequestBytes: 4096,
      async call(method: string, params: unknown) {
        if (method === 'fail') throw new Error('intentional failure')
        return { method, params }
      },
    } as never)
    servers.push(server)
    await server.start()

    await expect(requestRefineSkill(socketPath, { method: 'echo', params: { value: 1 } })).resolves.toEqual({
      method: 'echo', params: { value: 1 },
    })
    await expect(requestRefineSkill(socketPath, { method: 'fail' })).rejects.toThrow('intentional failure')
  })
})

it('refuses to replace a listening socket and releases ownership on dispose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-socket-owner-')); roots.push(root)
  const socketPath = join(root, 's.sock')
  const gateway = { maxRequestBytes: 4096, async call(method: string) { return { method } } }
  const first = new RefineSkillServer(socketPath, gateway); servers.push(first)
  await first.start()
  const second = new RefineSkillServer(socketPath, gateway)
  await expect(second.start()).rejects.toMatchObject({ code: 'state-busy' })
  await second.dispose().catch(() => {})
  await expect(requestRefineSkill(socketPath, { method: 'alive' })).resolves.toEqual({ method: 'alive' })
  await first.dispose()
  servers.push(second)
  await second.start()
  await expect(requestRefineSkill(socketPath, { method: 'restarted' })).resolves.toEqual({ method: 'restarted' })
})
