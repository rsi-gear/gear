#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { chmod, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { atomicJson, cli, command, exampleRoot, hash, isMain, readJson } from './common.mjs'

async function artifactList(root) {
  const files = []
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, item.name)
      if (item.isDirectory()) await walk(absolute)
      else if (item.isFile()) { if (relative(root, absolute) !== 'manifest.json') files.push(absolute) }
      else throw new Error(`unsupported carrier file ${absolute}`)
    }
  }
  await walk(root)
  return Promise.all(files.sort().map(async file => { const bytes = await readFile(file); return { path: relative(root, file).split('\\').join('/'), digest: hash(bytes), bytes: bytes.length } }))
}

export async function bootstrap(targetRepository, { install = false, template = join(exampleRoot, 'target-carrier') } = {}) {
  await cp(template, targetRepository, { recursive: true, errorOnExist: true, force: false })
  await writeFile(join(targetRepository, '.gitignore'), 'node_modules/\n__pycache__/\n*.pyc\n')
  await mkdir(join(targetRepository, 'apps/cli/lib'), { recursive: true })
  await copyFile(join(targetRepository, 'fixed/launcher.mjs'), join(targetRepository, 'apps/cli/lib/bin.js'))
  await chmod(join(targetRepository, 'apps/cli/lib/bin.js'), 0o755)
  const run = args => command('git', args, { cwd: targetRepository })
  const writeManifest = async (base, parent) => {
    const body = { schemaVersion: 1, ...(parent ? { parentRef: parent } : {}), dshBaseRef: base,
      toolchainRef: 'kaggle-dsh-cpu-v1', sandboxProfileRef: 'kaggle-chroot-v1', artifacts: await artifactList(join(targetRepository, 'harness')) }
    const manifest = { ...body, digest: hash(JSON.stringify(body)) }
    await atomicJson(join(targetRepository, 'harness/manifest.json'), manifest)
    return manifest
  }
  await writeManifest('0'.repeat(40))
  await run(['init', '-b', 'codex/kaggle-target'])
  await run(['config', 'user.name', 'Gear Kaggle']); await run(['config', 'user.email', 'gear-kaggle@localhost'])
  if (install) await command('pnpm', ['install', '--frozen-lockfile'], { cwd: targetRepository })
  await run(['add', '.']); await run(['commit', '--no-gpg-sign', '-m', 'Initialize fixed Kaggle carrier'])
  const dshBaseRef = await run(['rev-parse', 'HEAD'])
  const manifest = await writeManifest(dshBaseRef, dshBaseRef)
  await run(['add', 'harness/manifest.json']); await run(['commit', '--no-gpg-sign', '-m', 'Seal initial Titanic pipeline'])
  return { targetRepository, dshBaseRef, initialChampion: { schemaVersion: 2, ref: await run(['rev-parse', 'HEAD']), manifestDigest: manifest.digest, updatedAt: new Date().toISOString() } }
}

export async function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: { source: { type: 'string' }, out: { type: 'string' },
    'hitch-repository': { type: 'string' }, 'hitch-root': { type: 'string' }, 'base-image': { type: 'string' },
    platform: { type: 'string', default: 'linux/amd64' }, seed: { type: 'string', default: '42' }, install: { type: 'boolean' }, synthetic: { type: 'boolean' } } })
  for (const key of ['source', 'out', 'hitch-repository', 'hitch-root', 'base-image']) if (!v[key]) throw new Error(`--${key} is required`)
  const out = resolve(v.out)
  try { await stat(out); throw new Error('output directory must not exist') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(out, { recursive: true })
  const datasets = join(out, 'datasets')
  const imported = JSON.parse(await command(process.execPath, [join(resolve(v['hitch-repository']), 'benchmark-packages/kaggle/import.mjs'),
    '--source', resolve(v.source), '--out', datasets, '--root', resolve(v['hitch-root']), '--base-image', v['base-image'],
    '--platform', v.platform, '--seed', v.seed, ...(v.synthetic ? ['--synthetic'] : [])]))
  const target = await bootstrap(join(out, 'target'), { install: v.install === true })
  const competitionFile = join(datasets, 'competition.json')
  const project = { schema_version: '1', kind: 'gear-kaggle-project', ...target,
    competitionFile, competitionDigest: hash(await readFile(competitionFile)),
    seedTaskRef: join(datasets, 'seed'), heldOutRef: join(datasets, 'held-out'), finalizationRef: join(datasets, 'finalization'),
    hitchRoot: resolve(v['hitch-root']), importer: imported }
  await readJson(join(project.seedTaskRef, 'benchmark.adapter.json'))
  await atomicJson(join(out, 'project.json'), project)
  process.stdout.write(`${JSON.stringify(project, null, 2)}\n`)
}
if (isMain(import.meta.url)) cli(main)
