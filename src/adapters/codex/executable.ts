import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { GearError } from '../../domain/errors.js'

const npmTargets: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
}

/** Resolve npm's launcher without executing JavaScript outside the Meta sandbox.
 * Direct binaries and explicitly supplied custom executables keep their identity. */
export async function resolveCodexExecutable(configured: string): Promise<string> {
  const executable = await realpath(configured)
  const packageRoot = resolve(dirname(executable), '..')
  let manifest: { name?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return executable
    throw error
  }
  if (manifest?.name !== '@openai/codex') return executable
  const bin = manifest.bin
  const entry =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object'
        ? (bin as Record<string, unknown>).codex
        : undefined
  if (typeof entry !== 'string' || resolve(packageRoot, entry) !== executable) return executable

  const platform = `${process.platform}-${process.arch}`
  const target = npmTargets[platform]
  if (!target) throw unavailable()
  const roots: string[] = []
  try {
    const dependency = createRequire(executable).resolve(`@openai/codex-${platform}/package.json`)
    roots.push(join(dirname(dependency), 'vendor'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
  }
  // Current packages use bin/; older npm releases bundled codex/ in the launcher.
  roots.push(join(packageRoot, 'vendor'))
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const root of roots) {
    for (const directory of ['bin', 'codex']) {
      const candidate = join(root, target, directory, name)
      try {
        await access(candidate, constants.X_OK)
        return await realpath(candidate)
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
  throw unavailable()
}

function unavailable(): GearError {
  return new GearError('codex-native-unavailable', 'The Codex npm launcher has no supported native binary', {
    next_action: 'Repair the Codex installation or configure the native Codex executable directly',
  })
}
