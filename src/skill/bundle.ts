import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import type { ResolvedDshPresetResource } from '../types.js'

const BUNDLED_SKILL_ROOT = fileURLToPath(new URL('../../skills/refine/', import.meta.url))

export interface BundledRefineSkill {
  name: string
  description: string
  content: string
  path: string
  digest: string
  resources: ResolvedDshPresetResource[]
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Hash the entire skill bundle, including references and invocation metadata. */
export async function loadBundledRefineSkill(directory = BUNDLED_SKILL_ROOT): Promise<BundledRefineSkill> {
  const root = await realpath(resolve(directory))
  const contents = new Map<string, Buffer>()
  async function visit(relativePath: string): Promise<void> {
    for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
      const path = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) contents.set(path, await readFile(join(root, path)))
      else throw new Error(`packaged refine skill contains a non-regular resource: ${path}`)
    }
  }
  await visit('')
  const text = contents.get('SKILL.md')?.toString('utf8')
  if (text === undefined) throw new Error('packaged refine skill has no SKILL.md')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text)
  if (match === null) throw new Error('packaged refine skill has invalid frontmatter')
  const metadata = load(match[1]!)
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('packaged refine skill has invalid metadata')
  }
  const fields = metadata as Record<string, unknown>
  if (fields.name !== 'refine' || typeof fields.description !== 'string' || fields.description.length === 0) {
    throw new Error('packaged refine skill identity is invalid')
  }
  const resources = [...contents.keys()].sort().map(logicalPath => ({
    logicalPath, kind: 'skill' as const, digest: sha256(contents.get(logicalPath)!),
  }))
  return {
    name: fields.name,
    description: fields.description,
    content: match[2]!.trimStart(),
    path: join(root, 'SKILL.md'),
    digest: sha256(JSON.stringify(resources)),
    resources,
  }
}
