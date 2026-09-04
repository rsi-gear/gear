import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import Include from '@deepseek-ai/cordis-plugin-include'

export const name = 'gear-target-harness-loader'
export const inject = ['loader']

const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function safePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) throw new Error(`invalid harness path: ${value}`)
  const parts = value.split('/')
  if (!ALLOWED_ROOTS.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`harness path escapes the mutable target roots: ${value}`)
  }
  return parts.join('/')
}

async function listFiles(root) {
  const output = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`target harness symlink is forbidden: ${relative(root, absolute)}`)
      if (info.isDirectory()) await visit(absolute)
      else if (info.isFile()) output.push(relative(root, absolute).split(sep).join('/'))
      else throw new Error(`unsupported target harness entry: ${relative(root, absolute)}`)
    }
  }
  await visit(root)
  return output.sort()
}

export async function verifyTargetHarness(repositoryRoot) {
  const harnessRoot = resolve(repositoryRoot, 'harness')
  const manifestPath = join(harnessRoot, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || !/^sha256:[0-9a-f]{64}$/.test(manifest.digest)) {
    throw new Error('target harness manifest has an invalid envelope')
  }
  const artifacts = []
  const declared = new Set()
  for (const item of manifest.artifacts) {
    const path = safePath(item?.path)
    if (declared.has(path)) throw new Error(`duplicate target artifact: ${path}`)
    declared.add(path)
    const content = await readFile(join(harnessRoot, ...path.split('/')))
    const digest = sha256(content)
    if (item.digest !== digest || item.bytes !== content.byteLength) throw new Error(`target artifact integrity mismatch: ${path}`)
    artifacts.push({ path, digest, bytes: content.byteLength })
  }
  const actual = (await listFiles(harnessRoot)).filter(path => path !== 'manifest.json')
  if (actual.length !== declared.size || actual.some(path => !declared.has(path))) {
    throw new Error('target harness tree contains undeclared artifacts')
  }
  const identity = {
    schemaVersion: 1,
    ...(manifest.parentRef === undefined ? {} : { parentRef: manifest.parentRef }),
    dshBaseRef: manifest.dshBaseRef,
    toolchainRef: manifest.toolchainRef,
    sandboxProfileRef: manifest.sandboxProfileRef,
    artifacts,
  }
  if (sha256(JSON.stringify(identity)) !== manifest.digest) throw new Error('target harness manifest digest mismatch')
  return { root: harnessRoot, manifest }
}

export async function apply(ctx, config) {
  if (typeof config?.repositoryRoot !== 'string' || !config.repositoryRoot) throw new Error('target repository root is required')
  const verified = await verifyTargetHarness(config.repositoryRoot)
  await ctx.plugin(Include, {
    path: join(verified.root, 'preset', 'agent.cordis.yml'),
    enableLogs: false,
  })
  ctx.provide('targetHarness', Object.freeze({
    ref: verified.manifest.digest,
    root: verified.root,
  }))
}
