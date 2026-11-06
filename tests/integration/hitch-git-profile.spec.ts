import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../../lib/cli.js', import.meta.url))

it.each(['sha1', 'sha256'])('validates real %s Git repositories at profile creation', async (format) => {
  const root = await mkdtemp(join(tmpdir(), 'gear-git-profile-'))
  const repository = join(root, 'source with spaces')
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
    GEAR_PROFILE_ROOT: join(root, 'profiles'),
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 })
  try {
    git('init', '--quiet', `--object-format=${format}`, repository)
    await writeFile(join(repository, 'runtime.txt'), 'immutable source fixture\n')
    git('-C', repository, 'add', 'runtime.txt')
    git('-C', repository, '-c', 'user.name=Gear Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
    const commit = git('-C', repository, 'rev-parse', 'HEAD').trim()
    expect(commit).toHaveLength(format === 'sha1' ? 40 : 64)
    expect(git('-C', repository, 'status', '--porcelain')).toBe('')
    for (const harness of ['deepseek', 'pi']) {
      const harnessRef = `${harness}@git+${pathToFileURL(repository).href}#${commit}`
      const profile = { kind: 'hitch', executable: 'hitch-not-invoked-during-profile-creation',
        root: join(root, 'hitch'), model: 'fixture', harnessRef,
        baseImage: 'python@sha256:' + 'b'.repeat(64), passEnv: [], timeoutMs: 1000 }
      const source = join(root, `${harness}.json`)
      await writeFile(source, JSON.stringify(profile))
      const result = spawnSync(process.execPath, [cli, 'profile', 'create', harness, '--from', source, '--json'],
        { cwd: root, env, encoding: 'utf8', timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(format === 'sha1' ? 0 : 1)
      expect(existsSync(join(env.GEAR_PROFILE_ROOT, `${harness}.json`))).toBe(format === 'sha1')
      if (format === 'sha256') expect(JSON.parse(result.stderr)).toMatchObject({
        code: 'invalid-profile', message: expect.stringContaining('40-character SHA-1 commit'),
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
