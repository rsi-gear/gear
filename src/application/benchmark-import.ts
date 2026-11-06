import { mkdir, mkdtemp, readFile, readdir, lstat, rename, rm, open } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { dump, load } from 'js-yaml'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import { publishFile, syncDirectory } from '../adapters/storage/atomic.js'
import { withFileLock } from '../adapters/storage/file-lock.js'
import { resolveProject } from './project-config.js'
import { pinImage } from './profile-service.js'
import { pythonJson } from './python.js'
import { benchmarkLimits } from '../adapters/python/benchmark-limits.js'

interface ImportFile {
  path: string
  digest: string
  size: number
  executable: boolean
}
interface PreparedImport {
  version: 2
  digest: string
  directory: string
  config: Record<string, unknown>
  validation_mode: 'holdout' | 'research'
  files: ImportFile[]
  blobs: Record<string, string>
  directories: string[]
  summary: Record<string, unknown>
}
interface ImportPlan {
  version: 1
  before: string
  prepared: PreparedImport
}
export interface BenchmarkImportOptions {
  source: string
  template?: 'text' | 'json' | 'files' | 'harbor'
  mode?: 'holdout' | 'research'
  resource_root?: string
}
const identifier = (value: string) => {
  if (!/^import_[a-f0-9]{64}$/u.test(value))
    throw new GearError('invalid-import-id', 'Use an import plan ID returned by benchmark import')
  return value
}
const containedPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  !!path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..')

function directoryPaths(files: ImportFile[], directories: string[]): Set<string> {
  const result = new Set(directories)
  for (const path of [...directories, ...files.map((file) => file.path)]) {
    let parent = dirname(path)
    while (parent !== '.') {
      result.add(parent)
      parent = dirname(parent)
    }
  }
  return result
}
function validate(prepared: PreparedImport): void {
  const limits = benchmarkLimits()
  const { digest, ...body } = prepared
  if (
    canonicalDigest(body) !== digest ||
    prepared.version !== 2 ||
    !prepared.blobs ||
    typeof prepared.blobs !== 'object' ||
    Array.isArray(prepared.blobs) ||
    !/^benchmarks\/import-[a-f0-9]{24}$/u.test(prepared.directory) ||
    !['holdout', 'research'].includes(prepared.validation_mode) ||
    !Array.isArray(prepared.files) ||
    !Array.isArray(prepared.directories) ||
    prepared.files.length > limits.maxFiles ||
    prepared.directories.length > limits.maxDirectories ||
    prepared.directories.some((path) => !containedPath(path) || path === 'benchmark.yaml') ||
    new Set(prepared.directories).size !== prepared.directories.length ||
    new Set(prepared.files.map((file) => file.path)).size !== prepared.files.length
  )
    throw new GearError('import-plan-invalid', 'Import proposal is invalid or changed')
  const sizes = new Map<string, number>()
  let uniqueBytes = 0,
    materializedBytes = 0
  for (const [digest, encoded] of Object.entries(prepared.blobs)) {
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(limits.maxUniqueBytes / 3) * 4)
      throw new GearError('import-plan-invalid', 'Invalid import content blob')
    const content = Buffer.from(encoded, 'base64')
    uniqueBytes += content.length
    if (
      content.toString('base64') !== encoded ||
      `sha256:${createHash('sha256').update(content).digest('hex')}` !== digest ||
      uniqueBytes > limits.maxUniqueBytes
    )
      throw new GearError('import-plan-invalid', 'Import blob digest or unique size does not match')
    sizes.set(digest, content.length)
  }
  const used = new Set<string>()
  for (const file of prepared.files) {
    if (
      !containedPath(file.path) ||
      file.path === 'benchmark.yaml' ||
      typeof file.executable !== 'boolean' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      sizes.get(file.digest) !== file.size
    )
      throw new GearError(
        'import-plan-invalid',
        'Imported resources need contained paths and valid blob references',
      )
    used.add(file.digest)
    materializedBytes += file.size
    if (materializedBytes > limits.maxMaterializedBytes)
      throw new GearError(
        'import-plan-invalid',
        'Materialized import exceeds maxMaterializedBytes in GEAR_BENCHMARK_LIMITS_JSON',
      )
  }
  if (used.size !== sizes.size)
    throw new GearError('import-plan-invalid', 'Import contains unreferenced content blobs')
  const directories = directoryPaths(prepared.files, prepared.directories)
  if (directories.size > limits.maxDirectories)
    throw new GearError('import-plan-invalid', 'Import exceeds maxDirectories in GEAR_BENCHMARK_LIMITS_JSON')
  if (directories.has('benchmark.yaml') || prepared.files.some((file) => directories.has(file.path)))
    throw new GearError('import-plan-invalid', 'Imported files and directories must not overlap')
}
export async function prepareBenchmarkImport(root: string, options: BenchmarkImportOptions) {
  await resolveProject(root)
  const before = await readFile(join(root, 'gear.yaml'), 'utf8')
  const imageDigests: Record<string, string> = {}
  if (options.template === 'harbor') {
    const images = await pythonJson(['benchmark', 'images'], { source: resolve(root, options.source) })
    if (!Array.isArray(images) || images.some((image) => typeof image !== 'string'))
      throw new GearError('import-images-invalid', 'Importer did not describe its base images')
    for (const image of images as string[]) imageDigests[image] = await pinImage(image)
  }
  const prepared = (await pythonJson(['benchmark', 'import'], {
    source: resolve(root, options.source),
    image_digests: imageDigests,
    template: options.template ?? 'text',
    mode: options.mode ?? 'holdout',
    ...(options.resource_root ? { resource_root: resolve(root, options.resource_root) } : {}),
  })) as PreparedImport
  validate(prepared)
  const plan: ImportPlan = { version: 1, before, prepared },
    id = `import_${canonicalDigest(plan).slice(7)}`
  await publishFile(join(root, '.gear', 'imports', `${id}.json`), JSON.stringify(plan), { immutable: true })
  return {
    plan_id: id,
    status: 'review_required',
    destination: prepared.directory,
    ...prepared.summary,
    validation_mode: prepared.validation_mode,
    next_action: `Review the saved task split, then gear benchmark import --apply ${id}`,
  }
}
async function sameFiles(
  directory: string,
  expected: Array<ImportFile & { bytes: Buffer }>,
  directories: string[],
): Promise<boolean> {
  const seen = new Set<string>()
  const expectedFiles = new Map(expected.map((file) => [file.path, file]))
  const expectedDirectories = directoryPaths(expected, directories),
    seenDirectories = new Set<string>()
  const visit = async (root: string, prefix = ''): Promise<void> => {
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
      throw new Error('Unsafe import directory')
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const name = prefix + entry.name,
        path = join(root, entry.name)
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(name)) throw new Error('Changed import directory')
        seenDirectories.add(name)
        await visit(path, name + '/')
      } else {
        const file = expectedFiles.get(name),
          info = await lstat(path)
        if (
          !file ||
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o111) !== (file.executable ? 0o100 : 0) ||
          info.size !== file.bytes.length ||
          !(await readFile(path)).equals(file.bytes)
        )
          throw new Error('Changed import resource')
        seen.add(name)
      }
    }
  }
  try {
    await visit(directory)
    return seen.size === expected.length && seenDirectories.size === expectedDirectories.size
  } catch {
    return false
  }
}
export async function applyBenchmarkImport(root: string, planId: string) {
  identifier(planId)
  return withFileLock(join(root, '.gear', 'config.lock'), async () => {
    let plan: ImportPlan
    try {
      plan = JSON.parse(
        await readFile(join(root, '.gear', 'imports', `${planId}.json`), 'utf8'),
      ) as ImportPlan
    } catch {
      throw new GearError('import-plan-unavailable', 'Saved import proposal is unavailable')
    }
    if (
      `import_${canonicalDigest(plan).slice(7)}` !== planId ||
      plan.version !== 1 ||
      typeof plan.before !== 'string'
    )
      throw new GearError('import-plan-invalid', 'Saved import plan changed; create a new proposal')
    validate(plan.prepared)
    const original = load(plan.before) as Record<string, unknown>
    const next = dump(
      {
        ...original,
        benchmark: `./${plan.prepared.directory}/benchmark.yaml`,
        validation: { mode: plan.prepared.validation_mode },
      },
      { flowLevel: 1, lineWidth: 100 },
    )
    const current = await readFile(join(root, 'gear.yaml'), 'utf8')
    if (current !== plan.before && current !== next)
      throw new GearError(
        'import-config-conflict',
        'gear.yaml changed after import preview; create a new proposal',
      )
    const parent = join(root, 'benchmarks'),
      destination = join(root, plan.prepared.directory)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if ((await lstat(parent)).isSymbolicLink())
      throw new GearError('import-path-escape', 'benchmarks must be an owned project directory')
    const contents = new Map(
      Object.entries(plan.prepared.blobs).map(([digest, encoded]) => [
        digest,
        Buffer.from(encoded, 'base64'),
      ]),
    )
    const files = plan.prepared.files.map((file) => ({
      ...file,
      bytes: contents.get(file.digest)!,
    }))
    const configBytes = Buffer.from(dump(plan.prepared.config, { lineWidth: 100 }))
    files.push({
      path: 'benchmark.yaml',
      digest: '',
      size: configBytes.length,
      executable: false,
      bytes: configBytes,
    })
    const existing = await lstat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      },
    )
    if (existing) {
      if (!(await sameFiles(destination, files, plan.prepared.directories)))
        throw new GearError(
          'import-content-conflict',
          'Import destination already contains changed content; no files were overwritten',
        )
    } else {
      const temporary = await mkdtemp(join(parent, '.import-'))
      try {
        for (const name of plan.prepared.directories)
          await mkdir(join(temporary, name), { recursive: true, mode: 0o700 })
        for (const file of files) {
          const path = join(temporary, file.path)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const descriptor = await open(path, 'wx', file.executable ? 0o700 : 0o600)
          try {
            await descriptor.writeFile(file.bytes)
            await descriptor.sync()
          } finally {
            await descriptor.close()
          }
        }
        const syncTree = async (path: string): Promise<void> => {
          for (const entry of await readdir(path, { withFileTypes: true }))
            if (entry.isDirectory()) await syncTree(join(path, entry.name))
          await syncDirectory(path)
        }
        await syncTree(temporary)
        await rename(temporary, destination)
        await syncDirectory(parent)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
    const compiled = (await pythonJson(['benchmark', 'compile', '--root', root], plan.prepared.config)) as {
      digest: string
      splits: { seed: string[]; held_out: string[] }
    }
    if (plan.prepared.validation_mode === 'holdout' && !compiled.splits.held_out.length)
      throw new GearError('held-out-required', 'Imported data lacks independent held-out tasks')
    await publishFile(join(root, 'gear.yaml'), next, {
      beforePublish: async () => {
        if ((await readFile(join(root, 'gear.yaml'), 'utf8')) !== current)
          throw new GearError('import-config-conflict', 'gear.yaml changed while applying the import')
      },
    })
    return {
      plan_id: planId,
      status: 'applied',
      benchmark: plan.prepared.directory + '/benchmark.yaml',
      digest: compiled.digest,
      ...plan.prepared.summary,
      validation_mode: plan.prepared.validation_mode,
      next_action: 'gear benchmark check',
    }
  })
}
