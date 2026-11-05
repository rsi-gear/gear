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
  await access(join(root, 'harness/workflows/titanic/pipeline.py'))
  if (checkManifest) await verifyHarness(root)
  return { ok: true, mutationRoot: 'workflows/titanic', runtime: 'not_checked' }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  if (process.argv.includes('--build')) {
    await access(join(root, 'apps/cli/lib/bin.js'))
    await verifyHarness(root)
  } else {
    const result = await checkCandidate(process.argv[2] ?? process.cwd())
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
}
