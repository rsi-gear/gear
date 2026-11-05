import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCandidate } from '../target-carrier/fixed/check.mjs'
import { files, hash, verifyHarness } from '../target-carrier/fixed/integrity.mjs'
import { installToolBoundary, pipelineTool } from '../target-carrier/fixed/target-loader.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gear-kaggle-carrier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(new URL('../target-carrier/', import.meta.url), root, { recursive: true })
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@localhost'])
  git(['add', '.']); git(['commit', '-qm', 'substrate'])
  const artifacts = []
  for (const path of await files(join(root, 'harness'))) {
    const data = await readFile(join(root, 'harness', path))
    artifacts.push({ path, digest: hash(data), bytes: data.length })
  }
  const body = { schemaVersion: 1, dshBaseRef: git(['rev-parse', 'HEAD']), toolchainRef: 'test', sandboxProfileRef: 'test', artifacts }
  await writeFile(join(root, 'harness/manifest.json'), JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) }))
  git(['add', '.']); git(['commit', '-qm', 'champion'])
  return root
}

test('checker accepts pipeline evolution while preserving fixed substrate', async t => {
  const root = await fixture(t)
  await verifyHarness(root)
  await writeFile(join(root, 'harness/workflows/titanic/model.json'), '{"C":2,"max_iter":1000}\n')
  assert.equal((await checkCandidate(root)).ok, true)
  await assert.rejects(verifyHarness(root), /mismatch/)
  await writeFile(join(root, 'fixed/runner.py'), 'print("bypass")\n')
  await assert.rejects(checkCandidate(root), /fixed carrier file changed/)
})

test('checker rejects untracked mutation escape and unexpected harness paths', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'harness/workflows/titanic/model.lock'), 'forbidden')
  await assert.rejects(checkCandidate(root), /fixed carrier file changed/)
})

test('monotonic execution guard denies future tools as well as shell/write', () => {
  let guard, created, restriction
  const ctx = { tools: { guard(value) { guard = value } }, on(name, callback) { assert.equal(name, 'agent/created'); created = callback } }
  installToolBoundary(ctx)
  for (const name of ['bash', 'write_file', 'run_code', 'future_tool']) assert.equal(typeof guard({ name }), 'string')
  assert.equal(guard({ name: 'run_pipeline' }), undefined)
  created({ agent: { ctx: { tools: { restrict(value) { restriction = value } } } } })
  assert.deepEqual(restriction, { allow: ['run_pipeline'] })
})

test('native tool schema and execution reject caller-controlled arguments', async () => {
  const tool = pipelineTool(async () => 'completed')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(await tool.execute({}, {}), 'completed')
  await assert.rejects(tool.execute({ command: 'bash' }, {}), /not a declared property|takes no arguments/)
})
