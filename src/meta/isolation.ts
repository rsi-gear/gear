import { createHash } from 'node:crypto'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { load as loadYaml } from 'js-yaml'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { ResolvedDshPresetRef, ResolvedDshPresetResource } from '../types.js'

const require = createRequire(import.meta.url)

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

async function canonical(path: string): Promise<string> {
  try {
    await access(path)
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(records)
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(records)]
}

interface MetaComposition {
  path: string
  entries: EntryOptions[]
}

/** Inspect the same static entry graph and patch semantics that Cordis mounts.
 * Dynamic expressions/executable includes cannot be safely attested offline. */
async function metaCompositions(preset: AgentPreset): Promise<MetaComposition[]> {
  const { entryListSchema, applyEntryPatches } = await import('@deepseek-ai/cordis-plugin-include')
  const compositions: MetaComposition[] = []
  async function read(path: string, ancestors: string[], patches?: PatchOptions[], initial?: unknown): Promise<void> {
    path = resolve(path)
    const canonicalPath = await canonical(path)
    if (ancestors.includes(canonicalPath) || ancestors.length >= 64) throw new Error(`cyclic or excessive Meta preset includes: ${path}`)
    if (!['.json', '.yaml', '.yml'].includes(extname(path))) {
      throw new Error(`cannot verify executable Meta preset include: ${path}`)
    }
    let data: unknown
    try {
      const text = await readFile(path, 'utf8')
      data = extname(path) === '.json' ? JSON.parse(text) : loadYaml(text, { schema: entryListSchema })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !Array.isArray(initial)) throw error
      data = initial
    }
    if (!Array.isArray(data)) throw new Error(`Meta preset composition must be an entry list: ${path}`)
    const entries = applyEntryPatches(data, patches, () => {})
    compositions.push({ path, entries: [] })
    const composition = compositions[compositions.length - 1]!
    async function visit(entries: EntryOptions[]): Promise<void> {
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') throw new Error(`invalid Meta preset entry in ${path}`)
        if (typeof entry.disabled === 'object' && entry.disabled !== null) {
          throw new Error(`cannot verify dynamic Meta preset entry in ${path}; use literal configuration`)
        }
        // Groups themselves mount even when disabled, but their descendants do not.
        const include = entry.name === 'cordis:include' || entry.name === '@deepseek-ai/cordis-plugin-include'
        const group = entry.name === 'cordis:group' || (entry.group && Array.isArray(entry.config))
        if (entry.disabled && (!entry.group || include || group)) continue
        if (records(entry).some(value => '__jsExpr' in value)) {
          throw new Error(`cannot verify dynamic Meta preset entry in ${path}; use literal configuration`)
        }
        if (group) {
          if (!Array.isArray(entry.config)) throw new Error(`invalid Meta preset group in ${path}`)
          await visit(entry.config)
          continue
        }
        composition.entries.push(entry)
        if (!include) continue
        const config = entry.config as { path?: unknown; patches?: PatchOptions[]; initial?: unknown } | undefined
        if (typeof config?.path !== 'string') throw new Error(`invalid Meta preset include path in ${path}`)
        const includedPath = fileURLToPath(new URL(config.path, pathToFileURL(path)))
        await read(includedPath, [...ancestors, canonicalPath], config.patches, config.initial)
      }
    }
    await visit(entries)
  }
  await read(preset.path, [])
  return compositions
}

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function resourceKind(path: string, compositionPath: string): ResolvedDshPresetResource['kind'] {
  if (path === compositionPath) return 'composition'
  const normalized = path.split(sep).join('/').toLowerCase()
  const name = basename(normalized)
  if (normalized.includes('/skills/')) return 'skill'
  if (normalized.includes('/workflows/')) return 'workflow'
  if (normalized.includes('/plugins/')) return 'plugin'
  if (name.includes('system') || name.includes('prompt')) return 'system-prompt'
  return 'document'
}

async function files(path: string, visited = new Set<string>()): Promise<string[]> {
  const resolved = await canonical(path)
  if (visited.has(resolved)) return []
  const metadata = await stat(resolved)
  if (metadata.isFile()) return [resolved]
  if (!metadata.isDirectory()) return []
  visited.add(resolved)
  const found: string[] = []
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    found.push(...await files(resolve(resolved, entry.name), visited))
  }
  return found
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

/** Resolve the complete local file identity visible through a DSH preset.
 * The preset directory is always included. Existing file/directory references
 * in the composition are included even when they live outside that directory. */
export async function resolveDshPresetRef(preset: AgentPreset): Promise<ResolvedDshPresetRef> {
  const compositionPath = await canonical(preset.path)
  const presetRoot = dirname(compositionPath)
  const compositions = await metaCompositions(preset)
  const roots = new Map<string, string>([[presetRoot, 'preset']])
  for (const composition of compositions) {
    const includedPath = await canonical(composition.path)
    if (!within(includedPath, presetRoot) && await exists(includedPath) && !roots.has(includedPath)) {
      roots.set(includedPath, `include:${relative(presetRoot, includedPath).split(sep).join('/')}`)
    }
    for (const value of strings(composition.entries)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) continue
      const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
      const candidate = isAbsolute(expanded) ? expanded : resolve(dirname(composition.path), expanded)
      if (!await exists(candidate)) continue
      const resolved = await canonical(candidate)
      if (within(resolved, presetRoot) || roots.has(resolved)) continue
      roots.set(resolved, `reference:${relative(presetRoot, resolved).split(sep).join('/')}`)
    }
  }
  const byPath = new Map<string, ResolvedDshPresetResource>()
  for (const [root, prefix] of roots) {
    for (const path of await files(root)) {
      const canonicalPath = await canonical(path)
      if (byPath.has(canonicalPath)) continue
      const logicalPath = root === canonicalPath ? prefix : `${prefix}/${relative(root, canonicalPath).split(sep).join('/')}`
      byPath.set(canonicalPath, {
        logicalPath,
        kind: resourceKind(canonicalPath, compositionPath),
        digest: sha256(await readFile(canonicalPath)),
      })
    }
  }
  const resources = [...byPath.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
  return { id: preset.id, digest: sha256(JSON.stringify(resources)), resources }
}

export async function resolveDshRuntimeIdentity(): Promise<{ type: 'dsh'; version: string; integrity: string }> {
  const manifestPath = require.resolve('@deepseek-ai/dsh-agent/package.json')
  const packageRoot = dirname(manifestPath)
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('installed DSH Agent package has no version identity')
  }
  const packageFiles = (await files(packageRoot)).sort()
  const packageIdentity = await Promise.all(packageFiles.map(async path => ({
    path: relative(packageRoot, path).split(sep).join('/'),
    digest: sha256(await readFile(path)),
  })))
  return {
    type: 'dsh',
    version: manifest.version,
    integrity: sha256(JSON.stringify(packageIdentity)),
  }
}

export async function assertMetaPresetIsolation(
  preset: AgentPreset,
  forbiddenRoots: readonly string[],
): Promise<void> {
  const roots = await Promise.all(forbiddenRoots.map(canonical))
  const presetPath = await canonical(preset.path)
  if (roots.some(root => within(presetPath, root))) {
    throw new Error(`refine-meta preset is inside a target harness root: ${preset.path}`)
  }
  for (const path of await files(dirname(presetPath))) {
    if (roots.some(root => within(path, root))) {
      throw new Error(`refine-meta preset contains a link into a target harness root: ${path}`)
    }
  }
  for (const composition of await metaCompositions(preset)) {
    const includedPath = await canonical(composition.path)
    if (roots.some(root => within(includedPath, root))) {
      throw new Error(`refine-meta composition references target harness content: ${composition.path}`)
    }
    for (const value of strings(composition.entries)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) continue
      const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
      const candidate = await canonical(isAbsolute(expanded) ? expanded : resolve(dirname(composition.path), expanded))
      if (roots.some(root => within(candidate, root))) {
        throw new Error(`refine-meta composition references target harness content: ${value}`)
      }
    }
  }
}

/** Reject prompt composition that would hide Gear's scoped capability and safety guidance. */
export async function assertMetaPresetComposesCapabilities(preset: AgentPreset): Promise<void> {
  const compositions = await metaCompositions(preset)
  const completePersona = compositions.flatMap(value => value.entries).find(value => {
    if (value.name !== '@deepseek-ai/dsh-persona') return false
    const config = value.config
    return typeof config === 'object' && config !== null
      && !Array.isArray(config)
      && (config as Record<string, unknown>).complete === true
  })
  if (completePersona !== undefined) {
    throw new Error(
      'refine-meta preset must not set @deepseek-ai/dsh-persona config.complete=true; '
      + 'a complete persona suppresses Gear capability and authoring guidance',
    )
  }
}

export async function assertMetaPresetOffloadingCoordinator(preset: AgentPreset): Promise<void> {
  const entries = (await metaCompositions(preset)).flatMap(composition => composition.entries)
  if (entries.some(entry => /dsh-compaction(?:-basic|-auto)?(?:$|\/)/u.test(entry.name))) {
    throw new Error('Gear context offloading requires a Meta preset without independent DSH compaction plugins')
  }
}
