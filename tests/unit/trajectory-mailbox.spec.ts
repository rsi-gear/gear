import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { trajectoryMailbox } from '../../src/adapters/codex/trajectory-gateway.js'

it('serves bounded requests once and rejects linked, oversized and wrong-method files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-trajectory-mailbox-'))
  const calls: unknown[] = []
  const mailbox = await trajectoryMailbox(root, async params => { calls.push(params); return { seed: 'trace' } })
  try {
    for (const kind of ['valid', 'linked', 'oversized', 'wrong-method']) {
      const id = randomUUID().replaceAll('-', ''), name = `${id}.json`
      const input = join(mailbox.requests, name), output = join(mailbox.responses, name)
      const request = JSON.stringify({ id, method: kind === 'wrong-method' ? 'run.submit' : 'trajectory.read', params: { source_ref: 'seed' } })
      if (kind === 'linked') {
        const privateFile = join(root, 'private.json')
        await writeFile(privateFile, request)
        await symlink(privateFile, input)
      } else await writeFile(input, kind === 'oversized' ? 'x'.repeat(32769) : request)
      const expected = kind === 'valid' ? { id, result: { seed: 'trace' } } : { id, error: { code: 'trajectory-request-invalid' } }
      await expect.poll(async () => JSON.parse(await readFile(output, 'utf8'))).toEqual(expected)
      expect(calls).toEqual([{ source_ref: 'seed' }])
      if (kind === 'valid') await writeFile(input, request)
    }
  } finally { await mailbox.dispose(); await rm(root, { recursive: true, force: true }) }
})
