import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('writes a private DSH auth file from the bound access token and clears the inherited env value', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gear-dsh-codex-bootstrap-'))
  try {
    const access = 'fixture-only-access-token'
    const envelope = Buffer.from(JSON.stringify({
      version: 1,
      access,
      accountId: 'fixture-account',
      expires: Date.now() + 60 * 60 * 1000,
    })).toString('base64')
    const bootstrap = new URL('../../assets/dsh-codex-credential-bootstrap.mjs', import.meta.url)
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        bootstrap.href,
        '-e',
        "process.stdout.write(process.env.DSH_OPENAI_CODEX_ACCESS_B64 === '' ? 'cleared' : 'present')",
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_OPENAI_CODEX_ACCESS_B64: envelope,
        },
      },
    )

    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('cleared')
    const authPath = join(home, '.openai-codex-auth.json')
    const document = JSON.parse(await readFile(authPath, 'utf8'))
    expect(document).toEqual({
      version: 1,
      credential: {
        type: 'oauth',
        access,
        refresh: 'task-bound-access-only',
        expires: expect.any(Number),
        accountId: 'fixture-account',
      },
    })
    if (process.platform !== 'win32') expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
