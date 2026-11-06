import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const baseImage = process.env.GEAR_TEST_BENCHMARK_IMAGE
if (!baseImage?.includes('@sha256:')) throw new Error('GEAR_TEST_BENCHMARK_IMAGE must name a locally available pinned Python image')
const root = mkdtempSync(join(tmpdir(), 'gear-harbor-template-'))
const source = resolve(import.meta.dirname, '..')
const python = process.env.GEAR_PYTHON ?? join(source, '.venv/bin/python')
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options })
const tags = []
try {
  for (const template of ['text', 'files']) {
    const project = join(root, template)
    run(process.execPath, [join(source, 'lib/cli.js'), 'init', project, '--template', template])
    const probe = JSON.parse(run(process.execPath, [join(source, 'lib/cli.js'), '--project', project,
      '--json', 'benchmark', 'probe', '--scorer', '--image', baseImage], { env: { ...process.env, GEAR_PYTHON: python } }))
    assert.equal(probe.status, 'passed')
    assert.equal(probe.environment, 'passed')
    assert.equal(probe.scorer, 'passed')
    assert.equal(probe.model_requests, 0)
    assert.equal(probe.baseline, false)
    assert.deepEqual(probe.fixtures.map(value => value.observed_score), [1, 0])
    assert.deepEqual(probe.cleanup_required, [])
    const config = { version: 1, source: './tasks.csv', template }
    const benchmark = JSON.parse(run(python, ['-m', 'gear', 'benchmark', 'compile', '--root', project], {
      input: JSON.stringify(config), env: { ...process.env, PYTHONPATH: join(source, 'python') },
    }))
    const id = benchmark.splits.seed[0], destination = join(project, 'compiled')
    run(python, ['-m', 'gear', 'benchmark', 'harbor', '--output', destination], {
      input: JSON.stringify({ benchmark, task_ids: [id], base_image: baseImage }),
      env: { ...process.env, PYTHONPATH: join(source, 'python') },
    })
    // Round-trip the compiled fixture through the native importer before running its original verifier.
    const nativePlan = JSON.parse(run(process.execPath, [join(source, 'lib/cli.js'), '--project', project, '--json', 'benchmark', 'import', destination, '--template', 'harbor', '--research'], { env: { ...process.env, GEAR_PYTHON: python } }))
    run(process.execPath, [join(source, 'lib/cli.js'), '--project', project, '--json', 'benchmark', 'import', '--apply', nativePlan.plan_id], { env: { ...process.env, GEAR_PYTHON: python } })
    const nativeProbe = JSON.parse(run(process.execPath, [join(source, 'lib/cli.js'), '--project', project,
      '--json', 'benchmark', 'probe', '--scorer', '--image', baseImage], { env: { ...process.env, GEAR_PYTHON: python } }))
    assert.equal(nativeProbe.environment, 'passed')
    assert.equal(nativeProbe.scorer, 'not_run')
    assert.equal(nativeProbe.status, 'not_run')
    const nativeBenchmark = JSON.parse(run(python, ['-m', 'gear', 'benchmark', 'compile', '--root', project], {
      input: JSON.stringify(JSON.parse(readFileSync(join(project, '.gear/imports', nativePlan.plan_id + '.json'), 'utf8')).prepared.config), env: { ...process.env, PYTHONPATH: join(source, 'python') },
    }))
    const nativeDestination = join(project, 'native-compiled')
    run(python, ['-m', 'gear', 'benchmark', 'harbor', '--output', nativeDestination], { input: JSON.stringify({ benchmark: nativeBenchmark, task_ids: [id], base_image: baseImage }), env: { ...process.env, PYTHONPATH: join(source, 'python') } })
    const task = join(nativeDestination, id), tag = `gear-template-check:${process.pid}-${template}`
    tags.push(tag)
    run('docker', ['build', '--network=none', '-t', tag, join(task, 'environment')])
    const workspace = join(project, 'workspace'), logs = join(project, 'logs')
    mkdirSync(workspace); mkdirSync(logs)
    for (const correct of [true, false]) {
      const outputs = template === 'text' ? { 'answer.txt': correct ? benchmark.verifiers[id].expected : 'incorrect' }
        : Object.fromEntries(Object.entries(benchmark.verifiers[id].expected).map(([name, value]) => [name, correct ? value : 'incorrect']))
      for (const [name, value] of Object.entries(outputs)) writeFileSync(join(workspace, name), value)
      run('docker', ['run', '--rm', '--network=none', '--mount', `type=bind,src=${workspace},dst=/app`,
        '--mount', `type=bind,src=${join(task, 'tests')},dst=/tests,readonly`, '--mount', `type=bind,src=${logs},dst=/logs/verifier`, tag, 'sh', '/tests/test.sh'])
      assert.equal(Number(readFileSync(join(logs, 'reward.txt'), 'utf8')), correct ? 1 : 0)
      assert.equal(JSON.parse(readFileSync(join(logs, 'gear-result.json'), 'utf8')).status, 'valid')
    }
    process.stdout.write(`${template}: native import round-trip, real Docker environment and verifier positive/negative cases passed\n`)
  }
} finally {
  for (const tag of tags) { try { run('docker', ['image', 'rm', tag]) } catch {} }
  rmSync(root, { recursive: true, force: true })
}
