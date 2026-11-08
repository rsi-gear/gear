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
console.log('Analysis boundary: initial harness only; no task execution modules or dependencies in Gear')
