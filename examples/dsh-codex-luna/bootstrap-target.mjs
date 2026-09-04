#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const exampleRoot = dirname(fileURLToPath(import.meta.url))
const gearRoot = resolve(exampleRoot, '../..')
const labRoot = resolve(process.env.GEAR_LAB_ROOT ?? join(gearRoot, '.evolve-lab'))
const targetRoot = resolve(process.argv[2] ?? process.env.GEAR_TARGET_REPOSITORY ?? join(labRoot, 'target-dsh'))
const templateRoot = join(exampleRoot, 'target-carrier')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function artifacts() {
  const harnessRoot = join(targetRoot, 'harness')
  const paths = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name !== 'manifest.json') paths.push(relative(harnessRoot, absolute).split(sep).join('/'))
    }
  }
  await visit(harnessRoot)
  return Promise.all(paths.sort().map(async path => {
    const content = await readFile(join(harnessRoot, path))
    return { path, digest: sha256(content), bytes: content.byteLength }
  }))
}

async function writeManifest(dshBaseRef, parentRef) {
  const identity = {
    schemaVersion: 1,
    ...(parentRef === undefined ? {} : { parentRef }),
    dshBaseRef,
    toolchainRef: process.env.GEAR_TOOLCHAIN_REF ?? 'dsh-rc2-codex-pnpm-11.7.0',
    sandboxProfileRef: process.env.GEAR_SANDBOX_PROFILE_REF ?? 'harbor-terminal-bench-2.0',
    artifacts: await artifacts(),
  }
  const manifest = { ...identity, digest: sha256(JSON.stringify(identity)) }
  await writeFile(join(targetRoot, 'harness', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

await stat(targetRoot).then(
  () => { throw new Error(`target repository already exists: ${targetRoot}`) },
  error => { if (error?.code !== 'ENOENT') throw error },
)
await mkdir(dirname(targetRoot), { recursive: true })
await cp(templateRoot, targetRoot, { recursive: true })
await writeManifest('0000000000000000000000000000000000000000')
run('git', ['init', '-b', 'dev'])
run('git', ['config', 'user.name', 'Gear Lab'])
run('git', ['config', 'user.email', 'gear-lab@localhost'])
if (process.env.GEAR_SKIP_TARGET_INSTALL !== '1') run('pnpm', ['install'])
run('git', ['add', '.'])
run('git', ['commit', '-m', 'chore: seed Luna target substrate'])
const dshBaseRef = run('git', ['rev-parse', 'HEAD'])
const manifest = await writeManifest(dshBaseRef, dshBaseRef)
run('git', ['add', 'harness/manifest.json'])
run('git', ['commit', '-m', 'chore: seed Luna target champion'])
const championRef = run('git', ['rev-parse', 'HEAD'])
const metadata = {
  schemaVersion: 1,
  targetRepository: targetRoot,
  dshBaseRef,
  initialChampion: {
    schemaVersion: 2,
    ref: championRef,
    manifestDigest: manifest.digest,
    updatedAt: new Date().toISOString(),
  },
}
await writeFile(join(labRoot, 'target.json'), `${JSON.stringify(metadata, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`)
