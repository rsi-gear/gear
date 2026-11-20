// Protocol fixture. OS isolation and request metering are tested by Hitch;
// Gear tests authorization, schema validation, durable receipts and recovery.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export async function metaHitchFixture({ mode, adapter }) {
  const args = process.argv.slice(2)
  if (args.includes('capabilities')) {
    console.log(JSON.stringify({ isolated_agent_run: '1', generation_budget: '1' }))
    return
  }
  if (args.includes('runtime')) {
    console.log(JSON.stringify({ schema_version: '2', package_version: '0.2.18', node_version: process.version,
      runtime_id: 'sha256:' + 'a'.repeat(64), source: { kind: 'unavailable', commit: null, dirty: null } }))
    return
  }
  assert(args.includes('run') && args.includes('--watch-stdin'))
  const request = JSON.parse(await readFile(args[args.indexOf('--request-file') + 1], 'utf8'))
  const policy = request.isolation
  const root = dirname(request.cwd)
  const view = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'))
  const schema = JSON.parse(await readFile(policy.output_schema, 'utf8'))
  assert.equal(request.harness_ref, 'codex@installed')
  assert.equal(policy.reasoning_effort, 'max')
  assert(policy.read_paths.includes(request.cwd))
  assert(policy.read_paths.includes(join(root, 'input.json')))
  assert(policy.write_paths.includes(dirname(policy.output_file)))
  assert(!policy.read_paths.includes(root), 'private handoff file must not be model-readable')
  assert.equal(policy.write_paths.includes(request.cwd), view.operation?.kind === 'generate_candidate')
  assert(!('HTTP_PROXY' in process.env) && !('HTTPS_PROXY' in process.env))
  const readable = file => policy.read_paths.some(p => { const child = relative(p, file); return !child || (!child.startsWith('..') && !child.startsWith('/')) })
  let finished = false
  const usage = mode === 'partialfailed'
    ? { input_tokens: null, output_tokens: null, cached_input_tokens: null, tokens: null, model_requests: 2 }
    : { input_tokens: 12, output_tokens: 7, cached_input_tokens: 3, tokens: 19, model_requests: 1 }
  const finish = (status, error) => {
    if (finished) return
    finished = true
    process.stdin.pause()
    console.log(JSON.stringify({ schema_version: '1', run_id: 'run_' + 'a'.repeat(32), status,
      execution: { stopped: true }, generation_usage: usage, ...(error ? { error: { code: error } } : {}) }))
    process.exit(status === 'succeeded' ? 0 : 1)
  }
  process.on('SIGTERM', () => finish('cancelled', 'cancelled'))
  process.stdin.once('end', () => finish('cancelled', 'cancelled'))
  process.stdin.resume()
  process.stderr.write(JSON.stringify({ type: 'test.started', pid: process.pid, cwd: request.cwd }) + '\n')
  if (mode === 'hold') await delay(60000)
  if (mode === 'slow') await delay(2500)
  let result
  if (mode === 'operator') {
    assert.equal(view.request.prompt, 'Choose between the frozen donor materials')
    assert.equal(view.sources.length, 2)
    for (const [index, source] of view.sources.entries()) {
      const file = join(request.cwd, source.path, 'prompt.md')
      assert(readable(file))
      assert.equal(await readFile(file, 'utf8'), 'donor ' + ['one', 'two'][index])
      assert(!policy.write_paths.includes(dirname(file)))
    }
    result = { declined: false, data: { selected: 'donor two' } }
  } else if (mode.startsWith('operator-history')) {
    assert.equal(view.sources.length, view.request.data.round === 0 ? 3 : 6)
    const observed = []
    for (const source of view.sources) {
      const manifest = JSON.parse(await readFile(join(request.cwd, source.path, 'source.json'), 'utf8'))
      observed.push(manifest.label)
      assert(readable(join(request.cwd, source.path, 'source.json')))
      assert(!policy.write_paths.includes(join(request.cwd, source.path)))
      if (manifest.label === 'older rejected candidate') {
        const large = await readFile(join(request.cwd, source.path, 'large-source.py'), 'utf8')
        assert(large.length > 256_000, 'the complete source exceeds the diff-patch cap')
        assert.equal(large.slice(0, 27), '# Historical implementation')
        assert(readable(join(request.cwd, source.path, 'large-source.py')))
      }
    }
    assert(observed.includes('successful baseline trajectory'))
    assert(observed.includes('failed baseline trajectory'))
      const data = { base_candidate_id: view.request.data.round === 1 ? 'older-rejected' : 'anchor' }
      const required = schema.properties.data.required ?? []
      if (required.includes('summary')) data.summary = 'Inspect the seed archive before proposing.'
      if (required.includes('hypothesis')) data.hypothesis = 'Reuse a general mechanism from the selected base.'
      if (view.request.data.round === 1) {
        assert(observed.includes('older rejected candidate'))
        assert(observed.includes('successful older trajectory'))
        assert(observed.includes('failed older trajectory'))
      }
      result = { declined: false, data }
  } else {
    assert.equal(view.tasks[0].id, 'seed')
    if (view.experience && mode !== 'historical-sdk') {
      const memory = view.experience
      assert.equal(memory.cards[0].classification.effect, 'regressed')
      assert(readable(memory.reader.argv[0]))
      const invoke = body => {
        const call = spawnSync(memory.reader.argv[0], memory.reader.argv.slice(1), { input: JSON.stringify(body), encoding: 'utf8' })
        assert.equal(call.status, 0, call.stderr + call.stdout)
        return JSON.parse(call.stdout)
      }
      const page = invoke({ action: 'query', query: { effects: ['regressed'] } })
      assert.equal(page.total, 1)
      const ref = page.items[0].card.ref
      assert.equal(invoke({ action: 'read', ref, view: 'diff' }).items[0].patch, '-before\n+after\n')
      if (memory.reader.trajectory) {
        const source = invoke({ action: 'read', ref, view: 'trajectory' }).items[0].ref
        assert.equal(invoke({ action: 'trajectory', ref, source_ref: source, query: { limit: 1 } }).items[0].data, 'historical seed trace')
      }
    }
    if (view.operation.kind === 'generate_candidate')
      await writeFile(join(request.cwd, adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'), 'Use the requested output format.')
    if (mode === 'protected') await writeFile(join(request.cwd, 'package.json'), '{}')
    if (mode === 'invalid-result') result = { summary: 'bad', declined: false, hypotheses: [42], clusters: [] }
    else if (mode === 'declined') result = { summary: 'no change', declined: true, hypotheses: [], clusters: [] }
    else if (mode.startsWith('historical') && view.operation.kind === 'diagnose_seed') {
      const custom = view.operation.payload.meta, key = custom.schema.required[0]
      assert.deepEqual(schema.properties.data, custom.schema)
      const choices = schema.properties.data.properties[key].enum
      result = { declined: false, data: { [key]: mode === 'historical-invalid' ? 'outside' : choices.at(-1) } }
    } else if (mode.startsWith('historical')) result = { declined: false, data: 'Updated the selected candidate.' }
    else result = { summary: 'read isolation verified', declined: false, hypotheses: ['Respect output format'], clusters: [{ task_ids: ['seed'], hypotheses: ['Respect output format'] }] }
  }
  await writeFile(policy.output_file, mode === 'invalid' ? 'not json' : JSON.stringify(result))
  finish(mode === 'partialfailed' ? 'failed' : 'succeeded', mode === 'partialfailed' ? 'generation_usage_unknown' : undefined)
}
