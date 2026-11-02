import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GearError } from '../../domain/errors.js'

export const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
export const pythonSourceRoot = join(packageRoot, 'python')
export const managedPythonRoot = (): string =>
  join(process.env.GEAR_HOME ?? join(homedir(), '.local', 'share', 'gear'), 'python', '0.2.2')

/** Shared selection for asynchronous author tools and synchronous policy workers. */
export function resolvePythonExecutable(testOverride = false): string {
  const explicit =
    process.env.GEAR_PYTHON || (testOverride ? process.env.GEAR_TRAINING_TEST_PYTHON : undefined)
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK)
      return explicit
    } catch {
      throw new GearError('python-not-configured', 'Configured Python path is not executable')
    }
  }
  let managed: string | undefined
  try {
    const selected = JSON.parse(readFileSync(join(managedPythonRoot(), 'current.json'), 'utf8')) as {
      environment?: unknown
    }
    if (typeof selected.environment !== 'string' || !/^env-[a-zA-Z0-9]+$/u.test(selected.environment))
      throw new Error('Invalid managed environment')
    managed = join(managedPythonRoot(), selected.environment, 'bin/python')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new GearError('python-not-configured', 'Managed Python selection is invalid; rerun gear setup')
  }
  for (const path of [managed, join(packageRoot, '.venv/bin/python')]) {
    if (!path) continue
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      /* Try the next configured installation. */
    }
  }
  throw new GearError('python-not-configured', 'Run gear setup to install the managed Python worker', {
    next_action: 'gear setup',
  })
}
