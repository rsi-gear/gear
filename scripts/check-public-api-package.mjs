// Public execution exports and the removal of TypeScript algorithm author APIs.
// Python authoring, custom policies and dependency freezing are exercised by
// check-project-package.mjs from an installed wheel and npm package.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const source = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(tmpdir(), 'gear-public-api-'))
const run = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
try {
  const packed = JSON.parse(run(['pack', '--json', '--ignore-scripts', '--pack-destination', root], source))[0]
  const consumer = join(root, 'consumer'); mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], consumer)
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import * as api from 'rsi-gear';
import * as skill from 'rsi-gear/skill';
import * as training from 'rsi-gear/training';
assert.equal(typeof api.ProjectApplication, 'function');
assert.equal(typeof api.ProjectController, 'function');
assert.equal(skill.createProjectControlPlane, api.createProjectControlPlane);
for (const key of ['RefineService','FailureClusterSearch','ComponentRegistry','builtinComponentRef']) assert.equal(key in api, false);
assert.equal('createSkillControlPlane' in skill, false);
assert.equal('parseSkillHarnessIdentity' in skill, false);
for (const key of ['ModelIterationController', 'runIteration', 'ManagedNativeEndpointPreparer', 'parseNativeDeploymentProfile']) assert.equal(typeof training[key], 'function');
for (const path of ['rsi-gear/search','rsi-gear/search/api','rsi-gear/testing','rsi-gear/worker']) {
  await assert.rejects(import(path), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
}
console.log('Public project API passed; algorithm authoring is Python-only');
`], { cwd: consumer, encoding: 'utf8' })
  assert.match(output, /Public project API passed/u)
  process.stdout.write(output)
  const packageFiles = new Set(packed.files.map(file => file.path))
  for (const file of ['docs/training/unattended-iteration.zh-CN.md', 'docs/training/managed-native.zh-CN.md',
    'docs/unattended-model-iteration-design.zh-CN.md', 'docs/validation/unattended-scheduler-controlled-2026-10-15.json',
    'examples/training-loop/unattended/prepare.mjs', 'examples/training-loop/managed-native/prepare-profile.py',
    'python/gear/training/cli/native_deployment.py', 'python/gear/training/runtime/native_deployment.py',
    'python/gear/training/runtime/native_supervisor.py']) assert.ok(packageFiles.has(file), file)
  for (const file of ['assets/codex-meta-runner.mjs', 'assets/codex-process-guard.py', 'lib/adapters/codex/runner.js']) assert.ok(packageFiles.has(file), file)
  for (const file of ['assets/codex-skill-meta-runner.mjs', 'skills/refine/scripts/transport.mjs', 'lib/search/api.js', 'lib/search/index.js', 'lib/search/testing.js', 'lib/testing.js']) assert.ok(!packageFiles.has(file), file)
  for (const file of packageFiles) assert.ok(!/^(?:tests\/|fixture-lib\/|lib\/(?:search|refine|evaluator|meta|notebook|worker|candidate|experience)\/|lib\/state\/store\.|lib\/types\.)/u.test(file), `Retired implementation leaked into the package: ${file}`)
  for (const name of ['gates.py', 'history.py', 'observations.py']) assert.ok(!packageFiles.has(`python/gear/algorithms/${name}`), name)
  for (const file of packageFiles) assert.ok(!file.includes('retired_policies') && !file.includes('algorithms/_retired/'), file)
  const executable = join(root, 'codex-fixture')
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.145.0"; else exit 1; fi\n')
  chmodSync(executable, 0o700)
  const input = { version: 1, action: 'describe', request: null,
    configuration: { executable, model: 'fixture-model', allowedDomains: [], timeoutMs: 1000 },
    context: { runId: 'installed', directory: join(root, 'operations'), targets: join(root, 'targets'),
      targetAdapter: 'pi', protectedPaths: [consumer], tasks: [] } }
  const invoke = value => JSON.parse(execFileSync(join(consumer, 'node_modules/.bin/gear-meta-codex'), [], {
    cwd: consumer, encoding: 'utf8', input: JSON.stringify(value), stdio: ['pipe', 'pipe', 'pipe'],
  }))
  const handshake = invoke(input)
  assert.equal(handshake.version, 1)
  assert.match(handshake.identity, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(handshake.capabilities.inspect, true)
  assert.equal(handshake.admission, true)
  assert.equal(existsSync(input.context.directory), false)
  input.implementationIdentity = handshake.identity
  assert.deepEqual(invoke({ ...input, action: 'prepare_admission' }), { prepared: true })
  const journal = join(input.context.directory, 'operations.json')
  const saved = readFileSync(journal)
  input.request = { operationId: 'sha256:' + '1'.repeat(64), runId: 'installed', generation: 1,
    operation: { kind: 'diagnose_seed', candidate_id: 'anchor', parent_id: null, task_ids: [],
      scope: 'global', rationale: 'fixture', payload: null }, partition: 'seed', repetitions: 0, slots: [], evidence: [] }
  assert.deepEqual(invoke({ ...input, action: 'inspect' }), { state: 'not_submitted' })
  rmSync(input.context.directory, { recursive: true })
  assert.deepEqual(invoke({ ...input, action: 'inspect' }), { state: 'unknown' })
  assert.throws(() => invoke({ ...input, action: 'cancel' }), /codex-state-unavailable/)
  assert.equal(existsSync(input.context.directory), false)
  mkdirSync(input.context.directory)
  writeFileSync(journal, saved)
  assert.deepEqual(invoke({ ...input, action: 'cancel' }), { cancelled: true })
  assert.deepEqual(invoke({ ...input, action: 'cancel' }), { cancelled: true })
  console.log('Installed Codex admission, read-only describe, lost-state rejection and pre-start fence passed; zero model calls')
} finally { rmSync(root, { recursive: true, force: true }) }
