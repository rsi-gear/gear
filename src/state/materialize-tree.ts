import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, statfs } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface MaterializationPolicy {
  mode: 'auto' | 'require-clone' | 'copy'
  maxFallbackBytes?: number
  minFreeBytes?: number
}
export interface MaterializationReport {
  schemaVersion: 1
  sourceLogicalBytes: number
  clonedFiles: number
  clonedLogicalBytes: number
  copiedFiles: number
  copiedLogicalBytes: number
  fallbackReasons: Record<string, number>
  elapsedMs: number
}

export function materializationPolicy(input: unknown = { mode: 'auto' }): MaterializationPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid materialization policy')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['mode', 'maxFallbackBytes', 'minFreeBytes'].includes(key))
    || !['auto', 'require-clone', 'copy'].includes(value.mode as string)) throw new TypeError('invalid materialization mode or policy key')
  for (const key of ['maxFallbackBytes', 'minFreeBytes']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) throw new TypeError(`invalid materialization ${key}`)
  }
  return { ...value } as unknown as MaterializationPolicy
}

// Only explicit, tested unsupported-operation errors permit ordinary copying.
const unsupported = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])
const fingerprint = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':')
interface Entry { source: string; destination: string; info: Stats; resolved: string }

// copyFile without FICLONE can still share blocks via Linux copy_file_range.
// Explicit copy and unsupported-clone fallback use bounded reads/writes so the
// copy policy remains a genuine ordinary-copy baseline on a reflink filesystem.
async function copyBytes(entry: Entry, signal: AbortSignal): Promise<void> {
  const input = await open(entry.source, 'r')
  try {
    if (fingerprint(await input.stat()) !== fingerprint(entry.info)) throw new Error('materialization source changed')
    const output = await open(entry.destination, 'wx', 0o600)
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let total = 0
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        total += bytesRead
        if (total > entry.info.size) throw new Error('materialization source changed')
        for (let offset = 0; offset < bytesRead;) {
          signal.throwIfAborted()
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
          if (!bytesWritten) throw new Error('materialization copy made no progress')
          offset += bytesWritten
        }
      }
      if (total !== entry.info.size || fingerprint(await input.stat()) !== fingerprint(entry.info)) throw new Error('materialization source changed')
    } finally { await output.close() }
  } finally { await input.close() }
}

/** Only call for a caller-owned unpublished/quarantined tree. Never follow links. */
export async function removeOwnedTree(root: string): Promise<void> {
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (!info) return
  if (info.isDirectory()) {
    await chmod(root, info.mode | 0o700)
    for (const entry of await readdir(root)) await removeOwnedTree(join(root, entry))
  }
  await rm(root, { recursive: true, force: true })
}

/** Trusted, quiescent sources only. Path checks detect changes, but are not a security
 * boundary against a same-user process racing Node's path-based copyFile API.
 * Sequential copies bound open files to one and settle before returning on abort.
 * The caller owns the unpublished destination and its cleanup. */
export async function materializeTrees(
  trees: Array<{ source: string; destination: string }>,
  options: { policy?: MaterializationPolicy; signal: AbortSignal },
): Promise<MaterializationReport> {
  const policy = materializationPolicy(options.policy), started = performance.now()
  const report: MaterializationReport = { schemaVersion: 1, sourceLogicalBytes: 0, clonedFiles: 0, clonedLogicalBytes: 0, copiedFiles: 0, copiedLogicalBytes: 0, fallbackReasons: {}, elapsedMs: 0 }
  const entries: Entry[] = []
  for (const tree of trees) {
    const sourceRoot = await realpath(tree.source)
    const visit = async (source: string, destination: string): Promise<void> => {
      options.signal.throwIfAborted()
      const info = await lstat(source)
      if (!info.isDirectory() && !info.isFile()) throw new Error(`materialization refuses symlink or special file: ${source}`)
      const resolved = await realpath(source)
      const name = relative(sourceRoot, resolved)
      if (name === '..' || name.startsWith(`..${sep}`) || resolved !== resolve(sourceRoot, relative(tree.source, source))) throw new Error('materialization source path changed')
      entries.push({ source, destination, info, resolved })
      if (info.isDirectory()) for (const child of (await readdir(source)).sort()) await visit(join(source, child), join(destination, child))
    }
    await visit(tree.source, tree.destination)
  }
  const check = async (entry: Entry) => {
    options.signal.throwIfAborted()
    if (fingerprint(await lstat(entry.source)) !== fingerprint(entry.info) || await realpath(entry.source) !== entry.resolved) throw new Error('materialization source changed')
  }
  // Validate the whole input before the first write; check again around each copy.
  report.sourceLogicalBytes = entries.reduce((total, entry) => total + (entry.info.isFile() ? entry.info.size : 0), 0)
  for (const entry of entries) {
    await check(entry)
    if (entry.info.isDirectory()) { await mkdir(entry.destination, { mode: 0o700 }); continue }
    let cloned = false
    if (policy.mode !== 'copy') {
      try {
        await copyFile(entry.source, entry.destination, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL)
        cloned = true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
        if (policy.mode === 'require-clone' || !unsupported.has(code)) throw error
        report.fallbackReasons[code] = (report.fallbackReasons[code] ?? 0) + 1
      }
    }
    if (!cloned) {
      await check(entry)
      if (policy.maxFallbackBytes !== undefined && report.copiedLogicalBytes + entry.info.size > policy.maxFallbackBytes) throw new Error('materialization fallback byte budget exceeded')
      const space = await statfs(dirname(entry.destination), { bigint: true })
      if (space.bavail * space.bsize < BigInt(entry.info.size) + BigInt(policy.minFreeBytes ?? 0)) throw new Error('materialization free space reserve exceeded')
      await copyBytes(entry, options.signal)
      report.copiedFiles += 1; report.copiedLogicalBytes += entry.info.size
    } else { report.clonedFiles += 1; report.clonedLogicalBytes += entry.info.size }
    await check(entry)
    const destination = await lstat(entry.destination)
    if (!destination.isFile() || destination.dev === entry.info.dev && destination.ino === entry.info.ino) throw new Error('materialization destination is not an independent regular file')
    await chmod(entry.destination, entry.info.mode & 0o777)
  }
  for (const entry of entries) await check(entry)
  for (const entry of [...entries].reverse()) if (entry.info.isDirectory()) await chmod(entry.destination, entry.info.mode & 0o777)
  options.signal.throwIfAborted()
  report.elapsedMs = performance.now() - started
  return report
}
