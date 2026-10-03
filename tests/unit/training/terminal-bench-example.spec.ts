import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { jsonProcess } from '../../../src/training/process.js'
import { fixture, FixtureTrainer, FixtureEvaluator } from './fixture.js'
import { v2spec } from './placement-fixture.js'

it('admits the TB 2.1 Python example through the real v2 schema and CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-tb21-example-'))
  try {
    const store = new ModelTrainingStore(root), base = v2spec(await fixture(store))
    const script = `import json, pathlib, runpy, sys, tempfile
from gear_training.content import ContentStore
inputs = json.load(sys.stdin)
example = runpy.run_path(inputs['example'])
splits = {'train': ['one'], 'dev': ['two'], 'heldOut': ['three']}
bindings = {}
with tempfile.TemporaryDirectory() as directory:
    tasks = pathlib.Path(directory)
    for name in ('one', 'two', 'three'):
        task = tasks / name; task.mkdir()
        (task / 'task.toml').write_text('version = "1.0"\\n')
        (task / 'instruction.md').write_text(name)
        bindings[name] = {'family': name, 'environment': {key: 'sha256:' + 'a'*64 for key in ('hitchEnvironmentIdentity', 'taskDigest', 'verifierIdentity')}}
    print(json.dumps(example['prepare'](inputs['base'], tasks, splits, bindings, ContentStore(inputs['root']))))
`
    const spec = await jsonProcess(['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'],
      ['-c', script], { base, root, example: resolve('examples/training-loop/terminal-bench-2.1/prepare.py') }, 10_000)
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec)
    const run = await coordinator.admit(experiment.id)
    expect(run.request.trainer.script?.entrypoint).toBe('tb21:build_loop')
    expect(run.request.trainDataset.tasks.map(task => task.id)).toEqual(['one'])
    expect(run.request).not.toHaveProperty('datasets')
    expect(experiment.spec.evaluation.policy.requiredTaskIds).toEqual(['two', 'three'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
