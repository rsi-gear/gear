import assert from 'node:assert/strict'
import { readdir, readFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
assert.deepEqual(await readdir(join(root, 'examples/mle-bench')), ['harness'], 'MLE-bench examples must contain only the initial harness')
assert.equal(await access(join(root, 'integrations/analysis-research')).then(() => true, () => false), false,
  'Task execution belongs to Hitch')
for (const file of await readdir(join(root, 'src'), { recursive: true })) {
  if (!file.endsWith('.ts')) continue
  const source = await readFile(join(root, 'src', file), 'utf8')
  assert(!/agent-hitch\/analysis|analysis-research|analysis-round-cv|analysis-task@|titanic/i.test(source), `Task-specific production dependency: ${file}`)
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert(!pkg.exports['./analysis-research'] && !pkg.bin['gear-analysis'], 'Gear must not expose a task execution API')
assert(!pkg.dependencies?.['agent-hitch'] && !pkg.peerDependencies?.['agent-hitch'], 'Gear calls a generic process interface')
const harness = join(root, 'examples/mle-bench/harness')
for (const file of await readdir(harness, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue
  const source = await readFile(join(file.parentPath, file.name), 'utf8')
  assert(!/task_inspect|rollout_finish|analysis_execute|build_pipeline\(|experiment\(action|analysis-task@|analysis-round-cv/.test(source),
    `Removed research protocol in published harness: ${file.name}`)
}
for (const path of ['workflows/research', 'tools/experiment', 'prompts/operators']) {
  assert.equal(await access(join(harness, path)).then(() => true, () => false), false,
    `Removed research plugin remains in harness: ${path}`)
}
console.log('Analysis boundary: initial harness only; no task execution modules or dependencies in Gear')
