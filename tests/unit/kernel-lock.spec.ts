import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fileLockHeld, withFileLock } from '../../src/adapters/storage/file-lock.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-kernel-lock-')); roots.push(root)
  const lock = join(root, 'lock'), pidFile = join(root, 'keeper.pid'), wrapper = join(root, 'python')
  const python = process.env.GEAR_PYTHON || process.env.GEAR_TRAINING_TEST_PYTHON || 'python3'
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(python)} "$@"\n`, { mode: 0o700 })
  vi.stubEnv('GEAR_LOCK_PYTHON', wrapper)
  return { root, lock, pidFile }
}

it('retains kernel ownership after the helper dies until the protected callback finishes', async () => {
  const { lock, pidFile } = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const owner = withFileLock(lock, async () => { entered.resolve(); await release.promise })
  try {
    await entered.promise
    const pid = Number(await readFile(pidFile, 'utf8'))
    process.kill(pid, 'SIGKILL')
    await expect.poll(() => {
      try { process.kill(pid, 0); return false }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    }).toBe(true)
    expect(await fileLockHeld(lock)).toBe(true)
  } finally { release.resolve(); await owner }
  expect(await fileLockHeld(lock)).toBe(false)
  await expect(withFileLock(lock, async () => 'next owner')).resolves.toBe('next owner')
})

it('releases the retained descriptor after a callback failure', async () => {
  const { lock } = await fixture()
  await expect(withFileLock(lock, async () => { throw new Error('injected write failure') })).rejects.toThrow('injected write failure')
  expect(await fileLockHeld(lock)).toBe(false)
  await expect(withFileLock(lock, async () => 'recovered')).resolves.toBe('recovered')
})

it('releases both inherited descriptors when the Node owner is killed', async () => {
  const { lock } = await fixture()
  const module = new URL('../../lib/adapters/storage/file-lock.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { withFileLock } from ${JSON.stringify(module)};
await withFileLock(${JSON.stringify(lock)}, async () => {
  console.log('owned');
  await new Promise(() => {});
});
`], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const [chunk] = await once(child.stdout, 'data')
    expect(String(chunk).trim()).toBe('owned')
    expect(await fileLockHeld(lock)).toBe(true)
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
    await expect.poll(() => fileLockHeld(lock)).toBe(false)
    await expect(withFileLock(lock, async () => 'recovered')).resolves.toBe('recovered')
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})
