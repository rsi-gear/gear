import { execFileSync } from 'node:child_process'
import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { observeModificationUse } from '../../src/adapters/python/modification-use.js'
import { nativeManifestDigest } from '../../src/adapters/hitch/native-source.js'
import { ModificationUseStore } from '../../src/adapters/storage/modification-use.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform === 'win32')('rejects linked and special manifest/cache files without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-native-files-')); roots.push(root)
  const runId = 'run_' + 'a'.repeat(32), directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  const manifest = join(directory, 'trajectory.ref.json'), original = join(root, 'original')
  await writeFile(original, '{}')
  const cache = new ModificationUseStore(join(root, 'cache')), key = canonicalDigest('binding')
  await mkdir(cache.root)
  for (const destination of [manifest, cache.path(key)]) {
    const rejected = async () => {
      if (destination === manifest) expect(await nativeManifestDigest(root, runId)).toBeNull()
      else await expect(cache.read(key)).rejects.toThrow()
    }
    await symlink(original, destination); await rejected(); await rm(destination)
    await link(original, destination); await rejected(); await rm(destination)
    execFileSync('mkfifo', [destination]); await rejected(); await rm(destination)
  }
})

it('terminates a running native reader when its operation is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-native-observer-')); roots.push(root)
  const executable = join(root, 'reader'), ready = join(root, 'ready')
  await writeFile(executable, `#!${process.execPath}\nimport('node:fs').then(fs=>fs.writeFileSync(${JSON.stringify(ready)},''));setInterval(()=>{},1000)`, { mode: 0o700 })
  vi.stubEnv('GEAR_PYTHON', executable)
  const controller = new AbortController()
  const pending = observeModificationUse({}, controller.signal)
  const assertion = expect(pending).rejects.toMatchObject({ code: 'modification-observation-unavailable' })
  await vi.waitFor(async () => { await access(ready) }, { timeout: 5000, interval: 20 })
  controller.abort()
  await Promise.race([assertion, setTimeout(2000).then(() => { throw new Error('Reader did not stop after cancellation') })])
})
