import { createHash } from 'node:crypto'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { load as loadYaml } from 'js-yaml'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
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
  const composition = loadYaml(await readFile(compositionPath, 'utf8'))
  const roots = new Map<string, string>([[presetRoot, 'preset']])
  for (const value of strings(composition)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) continue
    const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
    const candidate = isAbsolute(expanded) ? expanded : resolve(presetRoot, expanded)
    if (!await exists(candidate)) continue
    const resolved = await canonical(candidate)
    if (within(resolved, presetRoot)) continue
    roots.set(resolved, `reference:${value}`)
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
  const composition = loadYaml(await readFile(preset.path, 'utf8'))
  for (const value of strings(composition)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) continue
    const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
    const candidate = await canonical(isAbsolute(expanded) ? expanded : resolve(dirname(preset.path), expanded))
    if (roots.some(root => within(candidate, root))) {
      throw new Error(`refine-meta composition references target harness content: ${value}`)
    }
  }
}
