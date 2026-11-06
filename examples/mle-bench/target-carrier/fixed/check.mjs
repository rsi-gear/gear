#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { files, mutable, verifyHarness } from './integrity.mjs'

export async function checkCandidate(repository, { checkManifest = false } = {}) {
  const root = resolve(repository)
  const manifest = JSON.parse(await readFile(join(root, 'harness/manifest.json'), 'utf8'))
  if (!/^[0-9a-f]{40,64}$/.test(manifest.dshBaseRef)) throw new Error('exact substrate commit required')
  // Include committed changes relative to the fixed substrate, unstaged changes,
  // and untracked files. Checking only the parent diff misses inherited bypasses.
  const changed = execFileSync('git', ['diff', '--name-only', '-z', manifest.dshBaseRef, '--'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const path of [...changed, ...untracked]) {
    if (path === 'harness/manifest.json') continue
    if (!path.startsWith('harness/') || !mutable(path.slice(8))) throw new Error(`fixed carrier file changed: ${path}`)
  }
  for (const path of await files(join(root, 'harness'))) {
    if (path !== 'manifest.json' && path !== 'preset/agent.cordis.yml' && !mutable(path)) throw new Error(`unsupported candidate file: ${path}`)
  }
  const preset = await readFile(join(root, 'harness/preset/agent.cordis.yml'), 'utf8')
  if (preset.replace(/^\s*#.*$/gm, '').trim() !== '[]') throw new Error('Kaggle harness preset must stay empty')
  await access(join(root, 'harness/workflows/research/policy.py'))
  await access(join(root, 'harness/workflows/research/memory.py'))
  for (const name of ['policy.py', 'memory.py']) {
    const text = await readFile(join(root, 'harness/workflows/research', name), 'utf8')
    if (Buffer.byteLength(text) > 65536) throw new Error('policy source exceeds limit')
    // Parse only; never import editable Python into the checker host process.
    execFileSync('python3', ['-c', 'import ast,sys; t=ast.parse(sys.stdin.read()); assert any(isinstance(n,ast.FunctionDef) and n.name==sys.argv[1] for n in t.body)',
      name === 'policy.py' ? 'next_action' : 'summarize_memory'], { input: text, timeout: 10000, maxBuffer: 65536 })
  }
  const config = JSON.parse(await readFile(join(root, 'harness/workflows/research/policy.json'), 'utf8'))
  if (Object.keys(config).sort().join(',') !== 'comparisonPrecision,preferCurrentOnTie'
    || typeof config.comparisonPrecision !== 'number' || !Number.isFinite(config.comparisonPrecision) || config.comparisonPrecision <= 0
    || typeof config.preferCurrentOnTie !== 'boolean') throw new Error('invalid research policy configuration')
  for (const name of await files(join(root, 'harness'))) if (name.endsWith('.md')
    && (await readFile(join(root, 'harness', name))).length > 32768) throw new Error('guidance exceeds limit')
  if (checkManifest) await verifyHarness(root)
  return { ok: true, mutationRoot: 'prompts,skills,workflows/research', runtime: 'not_checked' }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  if (process.argv.includes('--build')) {
    await access(join(root, 'apps/cli/lib/bin.js'))
    await verifyHarness(root)
  } else {
    const result = await checkCandidate(process.argv[2] ?? process.cwd())
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
}
