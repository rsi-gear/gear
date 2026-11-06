import { readFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { load } from 'js-yaml'
import { GearError } from '../domain/errors.js'
import type { CompiledBenchmark, ProjectConfig } from '../domain/project.js'
import { pythonJson } from './python.js'
export async function checkBenchmark(root: string, config: ProjectConfig): Promise<CompiledBenchmark> {
  const path = resolve(root, config.benchmark),
    offset = relative(root, path)
  if (offset.startsWith('..') || isAbsolute(offset))
    throw new GearError('benchmark-path-escape', 'benchmark.yaml must be inside the project')
  const benchmark = (await pythonJson(
    ['benchmark', 'compile', '--root', root],
    load(await readFile(path, 'utf8')),
  )) as CompiledBenchmark
  if (config.validation.mode === 'holdout' && !benchmark.splits.held_out.length)
    throw new GearError(
      'held-out-required',
      'No independent held-out tasks; explicitly choose validation.mode: research if intended',
    )
  return benchmark
}
