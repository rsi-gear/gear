import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'

export const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const mutable = path => /^(?:prompts|skills)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(path)
  || /^workflows\/research\/(?:policy\.py|memory\.py|policy\.json)$/.test(path)

export async function files(root) {
  const result = []
  async function visit(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`symlink forbidden: ${path}`)
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    else if (info.isFile()) result.push(relative(root, path).split(sep).join('/'))
    else throw new Error(`non-regular source: ${path}`)
  }
  await visit(root)
  return result.sort()
}

export async function verifyHarness(repository) {
  const root = resolve(repository, 'harness')
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('invalid harness manifest')
  const identity = { schemaVersion: 1, ...(manifest.parentRef === undefined ? {} : { parentRef: manifest.parentRef }),
    dshBaseRef: manifest.dshBaseRef, toolchainRef: manifest.toolchainRef, sandboxProfileRef: manifest.sandboxProfileRef,
    artifacts: manifest.artifacts }
  if (hash(JSON.stringify(identity)) !== manifest.digest) throw new Error('harness manifest digest mismatch')
  const declared = new Set()
  for (const item of manifest.artifacts) {
    if (typeof item.path !== 'string' || (!mutable(item.path) && item.path !== 'preset/agent.cordis.yml') || declared.has(item.path)) throw new Error('invalid or duplicate harness path')
    declared.add(item.path)
    const data = await readFile(join(root, item.path))
    if (data.length !== item.bytes || hash(data) !== item.digest) throw new Error(`harness artifact mismatch: ${item.path}`)
  }
  const actual = (await files(root)).filter(path => path !== 'manifest.json')
  if (actual.length !== declared.size || actual.some(path => !declared.has(path))) throw new Error('undeclared harness source')
  if (!declared.has('workflows/research/policy.py')) throw new Error('research policy is missing')
  const preset = await readFile(join(root, 'preset/agent.cordis.yml'), 'utf8')
  if (preset.replace(/^\s*#.*$/gm, '').trim() !== '[]') throw new Error('Kaggle harness preset must stay empty')
  return { root, manifest }
}
