import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command } from './common.mjs'
import { assert, digest, sha } from './contracts.mjs'
import { files, mutable } from '../target-carrier/fixed/integrity.mjs'
import { checkCandidate } from '../target-carrier/fixed/check.mjs'
import { sealHarness } from '../prepare.mjs'
import { locked } from './store.mjs'

const execute = promisify(execFile)

/** The Project target contains editable resources only. Carrier manifests are private to this bridge. */
export async function committedResources(repository, harness) {
  assert(/^[a-f0-9]{40}$/.test(harness.commit), 'exact carrier commit required')
  const read = async path => (await execute('git', ['show', `${harness.commit}:harness/${path}`],
    { cwd: repository, encoding: 'buffer', maxBuffer: 16777216 })).stdout
  const manifest = JSON.parse(await read('manifest.json'))
  const { digest: identity, ...body } = manifest
  assert(identity === harness.manifestDigest && sha(JSON.stringify(body)) === identity, 'carrier manifest changed')
  const tree = await command('git', ['ls-tree', '-r', '--name-only', harness.commit, '--', 'harness'], { cwd: repository })
  const paths = tree.split('\n').filter(Boolean).map(p => p.slice(8)).filter(p => p !== 'manifest.json').sort()
  assert(digest(paths) === digest(manifest.artifacts.map(f => f.path).sort()), 'undeclared carrier resource')
  const result = []
  for (const file of manifest.artifacts) {
    assert(mutable(file.path) || file.path === 'preset/agent.cordis.yml', 'unsupported carrier resource')
    const bytes = await read(file.path)
    assert(bytes.length === file.bytes && sha(bytes) === file.digest, 'carrier resource changed')
    result.push({ path: file.path, digest: sha(bytes), bytes })
  }
  return result.sort((a, b) => a.path < b.path ? -1 : 1)
}
export async function copyRegisteredTarget(repository, harness, destination) {
  for (const file of await committedResources(repository, harness)) {
    await mkdir(join(destination, file.path, '..'), { recursive: true })
    await writeFile(join(destination, file.path), file.bytes, { flag: 'wx', mode: 0o600 })
  }
}
export async function resourceIdentity(directory) {
  return digest(await Promise.all((await files(directory)).map(async path => {
    assert(mutable(path) || path === 'preset/agent.cordis.yml', 'only research resources may be edited')
    return { path, digest: sha(await readFile(join(directory, path))) }
  })))
}
const registeredIdentity = resources => digest(resources.map(({ path, digest }) => ({ path, digest })))

/** Materialize core-sealed resources on the fixed carrier without touching its checkout. */
export async function carrierForTarget(store, project, directory, registered = []) {
  const identity = await resourceIdentity(directory)
  for (const harness of registered) {
    if (registeredIdentity(await committedResources(project.targetRepository, harness)) === identity) {
      const changed = await command('git', ['diff', '--name-only', project.dshBaseRef, harness.commit], { cwd: project.targetRepository })
      assert(changed.split('\n').filter(Boolean).every(path => path === 'harness/manifest.json'
        || path.startsWith('harness/') && mutable(path.slice(8))), 'registered method changed the fixed carrier')
      return harness
    }
  }
  const key = digest({ base: project.dshBaseRef, resources: identity }).slice(7)
  return locked(store.path('locks', `carrier-${key}`), async () => {
    const previous = await store.load('carriers', key)
    if (previous) {
      assert(registeredIdentity(await committedResources(project.targetRepository, previous)) === identity, 'cached carrier changed')
      return previous
    }
    const clone = join(store.root, 'carrier-work', key)
    await rm(clone, { recursive: true, force: true })
    await command('git', ['clone', '--shared', '--no-checkout', project.targetRepository, clone])
    await command('git', ['checkout', '--detach', project.dshBaseRef], { cwd: clone })
    await rm(join(clone, 'harness'), { recursive: true })
    await cp(directory, join(clone, 'harness'), { recursive: true })
    for (const path of await files(join(clone, 'harness'))) await chmod(join(clone, 'harness', path), 0o600)
    const manifest = await sealHarness(clone, project.dshBaseRef)
    await checkCandidate(clone, { checkManifest: true })
    await command('git', ['add', 'harness'], { cwd: clone })
    await command('git', ['-c', 'user.name=Gear Analysis', '-c', 'user.email=gear-analysis@localhost', 'commit',
      '--no-gpg-sign', '-m', `Seal Project target ${identity}`], { cwd: clone })
    const commit = await command('git', ['rev-parse', 'HEAD'], { cwd: clone })
    await command('git', ['fetch', '--no-tags', clone, `${commit}:refs/gear/analysis/${key}`], { cwd: project.targetRepository })
    const harness = { commit, manifestDigest: manifest.digest }
    await store.save('carriers', key, harness)
    await rm(clone, { recursive: true, force: true })
    return harness
  })
}
