#!/usr/bin/env node
// Copied by bootstrap to apps/cli/lib/bin.js, the existing deepseek entrypoint.
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (!process.argv.includes('--version')) {
  const args = process.argv.slice(2)
  const separator = args.indexOf('--')
  if (separator < 0) throw new Error('headless prompt terminator is required')
  const options = args.slice(0, separator)
  const profiles = options.flatMap((arg, index) => arg === '--profile' ? [options[index + 1]] : [])
  if (profiles.length !== 1 || profiles[0] !== 'headless') throw new Error('Kaggle carrier only permits one headless profile')
  const dshHome = process.env.DSH_HOME
  if (!dshHome || !isAbsolute(dshHome)) throw new Error('absolute isolated DSH_HOME is required')
  process.env.DSH_REFINE_REPOSITORY = repositoryRoot
  process.env.DSH_REFINE_TARGET_LOADER_URL = pathToFileURL(join(repositoryRoot, 'fixed/target-loader.js')).href

  const credentialName = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
  if (!/^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/.test(credentialName)) throw new Error('invalid Codex credential variable name')
  const encoded = process.env[credentialName]
  if (encoded) {
    delete process.env[credentialName]
    const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    if (envelope?.version !== 1 || typeof envelope.access !== 'string' || typeof envelope.expires !== 'number'
        || typeof envelope.accountId !== 'string') throw new Error('invalid Codex access envelope')
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, '.openai-codex-auth.json'), JSON.stringify({ version: 1, credential: {
      type: 'oauth', access: envelope.access, refresh: 'disabled-in-disposable-target',
      expires: envelope.expires, accountId: envelope.accountId,
    } }), { mode: 0o600 })
  }
  const profile = join(dshHome, 'profiles/headless')
  await mkdir(profile, { recursive: true })
  const modules = join(dshHome, 'profiles/node_modules')
  await mkdir(modules, { recursive: true })
  const provider = join(repositoryRoot, 'node_modules/dsh-codex')
  const target = join(modules, 'dsh-codex')
  try { await symlink(provider, target, 'dir') }
  catch (error) { if (error.code !== 'EEXIST' || await realpath(target) !== await realpath(provider)) throw error }
  await copyFile(join(repositoryRoot, 'fixed/target-loader-shim.js'), join(profile, 'target-loader-shim.js'))
  // Apply the fixed policy last, before the prompt terminator. Subsequent
  // model routing patches cannot reopen its tools/preset restrictions.
  process.argv.splice(separator + 2, 0, '--patch', join(repositoryRoot, 'fixed/target.patch.yml'))
}
await import('@deepseek-ai/dsh/lib/bin.js')
