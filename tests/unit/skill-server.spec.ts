import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestRefineSkill } from '../../src/skill/client.js'
import { RefineSkillServer } from '../../src/skill/server.js'

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
