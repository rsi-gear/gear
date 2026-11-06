import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export interface PythonRuntime {
  executable: string
  readPaths: string[]
}
export async function inspectPython(pythonExecutable: string): Promise<PythonRuntime> {
  const script = [
    'import json, os, sys, sysconfig',
    'values = [sys.executable, sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix]',
    'values += list(sys.path) + list(sysconfig.get_paths().values())',
    'print(json.dumps({"executable":sys.executable,"paths":[os.path.realpath(p) for p in values if p and os.path.isabs(p)]}))',
  ].join('; ')
  const { stdout } = await execute(pythonExecutable, ['-I', '-c', script], { maxBuffer: 1024 * 1024 })
  const value = JSON.parse(stdout) as { executable: string; paths: string[] }
  if (
    typeof value.executable !== 'string' ||
    !Array.isArray(value.paths) ||
    value.paths.some((path) => typeof path !== 'string' || !isAbsolute(path))
  )
    throw new Error('Invalid Python runtime path inventory')
  const executable = resolve(value.executable),
    canonical = await realpath(executable)
  const readPaths = [
    ...new Set(
      [executable, dirname(executable), canonical, dirname(canonical), ...value.paths].map((path) =>
        resolve(path),
      ),
    ),
  ]
  const home = resolve(homedir())
  if (readPaths.some((path) => path === '/' || home === path || home.startsWith(`${path}/`)))
    throw new Error('Python runtime read path is too broad')
  return { executable, readPaths }
}
