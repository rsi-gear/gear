import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { load as loadYaml } from 'js-yaml'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'

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

export async function assertMetaPresetIsolation(
  preset: AgentPreset,
  forbiddenRoots: readonly string[],
): Promise<void> {
  const roots = await Promise.all(forbiddenRoots.map(canonical))
  const presetPath = await canonical(preset.path)
  if (roots.some(root => within(presetPath, root))) {
    throw new Error(`refine-meta preset is inside a target harness root: ${preset.path}`)
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
