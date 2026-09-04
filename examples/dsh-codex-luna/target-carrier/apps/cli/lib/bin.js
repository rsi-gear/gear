#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixedPatch = join(repositoryRoot, 'fixed', 'target.patch.yml')

if (!process.argv.includes('--version')) {
  process.env.DSH_REFINE_REPOSITORY = repositoryRoot
  process.env.DSH_REFINE_TARGET_LOADER_URL = pathToFileURL(join(repositoryRoot, 'fixed', 'target-loader.js')).href

  const profileIndex = process.argv.indexOf('--profile')
  if (profileIndex < 0 || process.argv[profileIndex + 1] !== 'headless') {
    throw new Error('Gear target carrier only permits the DSH headless profile')
  }
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome !== 'string' || dshHome.length === 0) throw new Error('DSH_HOME is required')
  const credentialName = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_AUTH_B64'
  const codexAuth = process.env[credentialName]
  if (codexAuth) {
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, '.openai-codex-auth.json'), Buffer.from(codexAuth, 'base64'), { mode: 0o600 })
    delete process.env[credentialName]
  }
  const profileRoot = join(dshHome, 'profiles', 'headless')
  await mkdir(profileRoot, { recursive: true })
  const profileModules = join(dshHome, 'profiles', 'node_modules')
  await mkdir(profileModules, { recursive: true })
  await symlink(join(repositoryRoot, 'node_modules', 'dsh-codex'), join(profileModules, 'dsh-codex'), 'dir')
  await copyFile(join(repositoryRoot, 'fixed', 'target-loader-shim.js'), join(profileRoot, 'target-loader-shim.js'))
  process.argv.splice(profileIndex + 2, 0, '--patch', fixedPatch)
}

await import('@deepseek-ai/dsh/lib/bin.js')
