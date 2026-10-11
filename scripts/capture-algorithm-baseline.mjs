#!/usr/bin/env node
/** Rebuild an immutable Git revision outside the working tree and record its search identities. */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function argumentsFrom(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--revision', '--output', '--node-modules', '--tool-fs-archive', '--expected'].includes(key) || !value || value.startsWith('--') || result[key]) {
      throw new Error('usage: node scripts/capture-algorithm-baseline.mjs --revision COMMIT --output NEW_DIRECTORY --tool-fs-archive PINNED_TGZ [--node-modules DIRECTORY] [--expected MANIFEST_JSON]')
    }
    result[key] = value
  }
  if (!result['--revision'] || !result['--output'] || !result['--tool-fs-archive']) throw new Error('revision, output and pinned ToolFs archive are required')
  return result
}

function command(executable, args, cwd, env = process.env) {
  return execFileSync(executable, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

async function fileRecord(root, path) {
  const bytes = await readFile(join(root, path))
  return { path, bytes: bytes.length, sha256: sha256(bytes) }
}

async function searchIdentity(root, extension, modules, protocolVersion) {
  const hash = createHash('sha256').update(`gear-search-protocol:${protocolVersion}\0`)
  const files = []
  for (const relative of [...modules.map(name => `${name}${extension}`), 'schema.json']) {
    const path = `search/${relative}`
    const bytes = await readFile(join(root, path))
    hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
    files.push({ path: `${root.endsWith('/src') ? 'src' : 'lib'}/${path}`, bytes: bytes.length, sha256: sha256(bytes) })
  }
  return { protocolVersion, integrity: `sha256:${hash.digest('hex')}`, files }
}

async function parentIdentity(root, extension, manifestRoot) {
  const paths = [`search/policies/parents${extension}`, `search/parent-random${extension}`]
  const hash = createHash('sha256')
  const files = []
  for (const path of paths) {
    const bytes = await readFile(join(root, path))
    hash.update(String(bytes.length)).update('\0').update(bytes).update('\0')
    files.push({ path: `${root.endsWith('/src') ? 'src' : 'lib'}/${path}`, bytes: bytes.length, sha256: sha256(bytes) })
  }
  const manifest = await readFile(join(manifestRoot, 'package.json'))
  hash.update(String(manifest.length)).update('\0').update(manifest).update('\0')
  files.push({ path: 'package.json', bytes: manifest.length, sha256: sha256(manifest) })
  return { integrity: `sha256:${hash.digest('hex')}`, files }
}

function readSearchContract(source) {
  const version = source.match(/export const searchProtocolVersion = (\d+)/u)
  const list = source.match(/const modules = \[([\s\S]*?)\]\s*const hash/u)
  if (!version || !list) throw new Error('unsupported search identity source layout; inspect this revision manually')
  const modules = [...list[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
  if (!modules.length || new Set(modules).size !== modules.length) throw new Error('invalid search identity source module list')
  return { version: Number(version[1]), modules }
}

async function archive(revision, destination) {
  const git = spawn('git', ['-C', repository, 'archive', '--format=tar', revision], { stdio: ['ignore', 'pipe', 'pipe'] })
  const tar = spawn('tar', ['-xf', '-', '-C', destination], { stdio: ['pipe', 'inherit', 'pipe'] })
  git.stdout.pipe(tar.stdin)
  let errors = ''
  git.stderr.on('data', chunk => { errors += chunk })
  tar.stderr.on('data', chunk => { errors += chunk })
  const finished = child => new Promise((resolveDone, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveDone() : reject(new Error(`${child.spawnfile} exited ${code}: ${errors}`)))
  })
  await Promise.all([finished(git), finished(tar)])
}

function compareExpected(actual, expected) {
  const keys = ['revision', 'package', 'packageLock', 'sourceSearch', 'builtSearch', 'sourceParentPolicy', 'builtParentPolicy', 'privateToolFsInput', 'packageTarball']
  for (const key of keys) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) throw new Error(`baseline differs from expected manifest: ${key}`)
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const revision = command('git', ['rev-parse', '--verify', `${options['--revision']}^{commit}`], repository)
  const output = resolve(options['--output'])
  const dependencyDirectory = await realpath(resolve(options['--node-modules'] ?? join(repository, 'node_modules')))
  if (!(await lstat(dependencyDirectory)).isDirectory()) throw new Error('node_modules must be a directory')
  // The destination must be new. This command never resets or replaces a user file.
  await mkdir(output, { recursive: false })
  const source = join(output, 'source')
  const build = join(output, 'build')
  const artifacts = join(output, 'artifacts')
  await mkdir(source)
  await archive(revision, source)
  const identitySource = await readFile(join(source, 'src/search/identity.ts'), 'utf8')
  const contract = readSearchContract(identitySource)
  const sourceSearch = await searchIdentity(join(source, 'src'), '.ts', contract.modules, contract.version)
  const sourceParentPolicy = await parentIdentity(join(source, 'src'), '.ts', source)
  const packageRecord = await fileRecord(source, 'package.json')
  const lockRecord = await fileRecord(source, 'package-lock.json')

  await cp(source, build, { recursive: true })
  await symlink(dependencyDirectory, join(build, 'node_modules'), 'dir')
  await mkdir(artifacts)
  const toolFsSource = await readFile(resolve(options['--tool-fs-archive']))
  const builder = await readFile(join(source, 'scripts/build-private-tool-fs.mjs'), 'utf8')
  const pinned = builder.match(/const version = '([^']+)'\s*const integrity = '(sha512-[^']+)'/u)
  if (!pinned) throw new Error('unsupported pinned private ToolFs builder layout')
  const actualIntegrity = `sha512-${createHash('sha512').update(toolFsSource).digest('base64')}`
  if (actualIntegrity !== pinned[2]) throw new Error('private ToolFs input does not match the old builder pin')
  const sourceArchive = join(artifacts, `dsh-tool-fs-${pinned[1]}.tgz`)
  await copyFile(resolve(options['--tool-fs-archive']), sourceArchive)
  const privateToolFsInput = await fileRecord(artifacts, `dsh-tool-fs-${pinned[1]}.tgz`)
  privateToolFsInput.path = `artifacts/${privateToolFsInput.path}`
  privateToolFsInput.integrity = actualIntegrity

  // The historical builder calls npm pack for this pinned tarball. Supply the
  // exact verified archive locally so the old script runs without registry I/O.
  const shimDirectory = join(output, 'offline-bin')
  await mkdir(shimDirectory)
  const shim = `#!/usr/bin/env node\nimport { copyFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst args = process.argv.slice(2)\nif (args[0] !== 'pack' || args[1] !== ${JSON.stringify(`@deepseek-ai/dsh-tool-fs@${pinned[1]}`)}) throw new Error('offline npm shim only permits the pinned ToolFs source pack')\nconst index = args.indexOf('--pack-destination')\nif (index < 0 || !args[index + 1]) throw new Error('pack destination missing')\nconst filename = ${JSON.stringify(`dsh-tool-fs-${pinned[1]}.tgz`)}\ncopyFileSync(${JSON.stringify(sourceArchive)}, join(args[index + 1], filename))\nprocess.stdout.write(JSON.stringify([{ filename }]))\n`
  await writeFile(join(shimDirectory, 'npm'), shim, { mode: 0o755, flag: 'wx' })
  const offlineEnvironment = { ...process.env, PATH: `${shimDirectory}:${process.env.PATH ?? ''}`, npm_config_offline: 'true' }
  command(process.execPath, ['scripts/build-private-tool-fs.mjs'], build, offlineEnvironment)
  command(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], build, { ...process.env, npm_config_offline: 'true' })
  const builtSearch = await searchIdentity(join(build, 'lib'), '.js', contract.modules, contract.version)
  const builtParentPolicy = await parentIdentity(join(build, 'lib'), '.js', build)
  const importedSearch = await import(pathToFileURL(join(build, 'lib/search/identity.js')).href)
  const importedPolicy = await import(pathToFileURL(join(build, 'lib/search/policies/parents.js')).href)
  if (importedSearch.searchImplementationIntegrity !== builtSearch.integrity
    || importedPolicy.parentPolicyImplementation.integrity !== builtParentPolicy.integrity) {
    throw new Error('captured identity disagrees with executable built runtime')
  }

  const npmCache = join(output, 'npm-cache')
  await mkdir(npmCache)
  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', artifacts], build,
    { ...process.env, npm_config_cache: npmCache, npm_config_offline: 'true' }))
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string') throw new Error('npm pack did not produce exactly one tarball')
  const packageTarball = await fileRecord(artifacts, packed[0].filename)
  packageTarball.path = `artifacts/${packed[0].filename}`

  const manifest = {
    schemaVersion: 1,
    revision,
    package: packageRecord,
    packageLock: lockRecord,
    sourceSearch,
    builtSearch,
    sourceParentPolicy,
    builtParentPolicy,
    privateToolFsInput,
    packageTarball,
    environment: {
      node: process.version,
      npm: command('npm', ['--version'], build),
      typescript: JSON.parse(await readFile(join(dependencyDirectory, 'typescript/package.json'), 'utf8')).version,
      vitest: JSON.parse(await readFile(join(dependencyDirectory, 'vitest/package.json'), 'utf8')).version,
      esbuild: JSON.parse(await readFile(join(dependencyDirectory, 'esbuild/package.json'), 'utf8')).version,
    },
    commands: [
      `git archive --format=tar ${revision}`,
      'node scripts/build-private-tool-fs.mjs (pinned archive supplied through offline npm pack shim)',
      'node node_modules/typescript/bin/tsc -p tsconfig.build.json',
      'npm pack --ignore-scripts --offline --json',
    ],
  }
  if (options['--expected']) compareExpected(manifest, JSON.parse(await readFile(resolve(options['--expected']), 'utf8')))
  await writeFile(join(output, 'baseline.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ output, revision, sourceSearch: sourceSearch.integrity, builtSearch: builtSearch.integrity,
    sourceParentPolicy: sourceParentPolicy.integrity, builtParentPolicy: builtParentPolicy.integrity, packageTarball: packageTarball.sha256 })}\n`)
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1 })
