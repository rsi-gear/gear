import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'gear-published-project-'))
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
const note = message => process.stdout.write(message + '\n')
try {
  note('Building an external npm installation and a base Python wheel')
  const tarball = process.env.GEAR_TEST_NPM_PACKAGE
    ? resolve(process.env.GEAR_TEST_NPM_PACKAGE)
    : join(root, JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: source }))[0].filename)
  const install = join(root, 'consumer'); mkdirSync(install)
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'gear-install-contract', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: install })
  const python = process.env.GEAR_SETUP_PYTHON ?? 'python3.12'
  const wheels = join(root, 'wheels'); mkdirSync(wheels)
  const wheelSource = join(root, 'wheel-source'); mkdirSync(wheelSource)
  for (const name of ['pyproject.toml', 'setup.py', 'gear']) cpSync(join(source, 'python', name), join(wheelSource, name), { recursive: true })
  // A removed module must not survive setuptools' incremental build directory.
  for (const name of ['gear_training/obsolete.py', 'gear/training/cli/launch.py', 'gear/training/cli/inference.py', 'gear/training/inference/inference_process.py', 'gear/training/inference/inference_attach.py', 'gear/training/inference/inference_recovery.py', 'gear/training/cli/__main__.py', 'gear/algorithms/history.py', 'gear/algorithms/gates.py', 'gear/algorithms/observations.py', 'gear/algorithms/_retired/__init__.py']) {
    const path = join(wheelSource, 'build/lib', name)
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'raise RuntimeError("retired module leaked into wheel")\n')
  }
  run(python, ['-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheels, wheelSource])
  const environment = join(root, 'python'); run(python, ['-m', 'venv', environment])
  const isolatedPython = join(environment, 'bin/python')
  run(isolatedPython, ['-m', 'pip', 'install', join(wheels, readdirSync(wheels).find(name => name.endsWith('.whl')))])
  run(isolatedPython, ['-c', 'import sys;import gear;import gear.training;import gear.benchmark.probe;import importlib;import importlib.util;assert all(importlib.util.find_spec(name) is None for name in ("gear_training","gear.training.cli.launch","gear.training.cli.__main__","gear.training.cli.inference","gear.training.inference.inference_process","gear.training.inference.inference_attach","gear.training.inference.inference_recovery","gear.algorithms.history","gear.algorithms.gates","gear.algorithms.observations","gear.algorithms._retired","retired_policies"));[importlib.import_module("gear.training.cli."+name) for name in ("controller","job","node","script_job","certify","slime","gpu_inventory")];assert not any(n in sys.modules for n in ("torch","slime","transformers","aiohttp"));from gear.algorithms import GEPA;from gear.algorithms.testkit import toy_round;assert toy_round(GEPA())["status"] == "passed"'], { cwd: root, env: { ...process.env, PYTHONPATH: '' } })
  for (const module of ['gear.training', 'gear.training.cli.node', 'gear.training.cli.job', 'gear.training.cli.native_deployment'])
    assert.match(run(isolatedPython, ['-m', module, '--help'], { cwd: root, env: { ...process.env, PYTHONPATH: '' } }), /usage:/)
  cpSync(join(source, 'examples/training-loop/linear_cpu.py'), join(root, 'linear_cpu.py'))
  run(isolatedPython, [join(root, 'linear_cpu.py'), '--workspace', join(root, 'training')], { cwd: root, env: { ...process.env, PYTHONPATH: '' } })
  const cli = join(install, 'node_modules/rsi-gear/lib/cli.js')
  const profiles = join(root, 'profiles'); mkdirSync(profiles)
  const adapter = join(root, 'fixture-provider.mjs'); cpSync(join(source, 'tests/fixtures/project-provider.mjs'), adapter)
  const profile = { command: [process.execPath, adapter], workingDirectory: root, passEnv: [], timeoutMs: 30000,
    configuration: { python: isolatedPython, receipts: join(root, 'receipts') } }
  const importProfile = join(root, 'provider-profile.json'); writeFileSync(importProfile, JSON.stringify(profile))
  const env = { ...process.env, GEAR_PYTHON: isolatedPython, GEAR_PROFILE_ROOT: profiles, PYTHONPATH: '', GEAR_HOME: join(root, 'managed') }
  note('Installed Python native-resource observer with pinned child-session sources')
  run(process.execPath, [join(source, 'scripts/check-modification-use.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  note('Installed Python verifier process projection and independent primary score')
  run(process.execPath, [join(source, 'scripts/check-verifier.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  note('Installed cancellation recovery without profiles, benchmark, Target or research files')
  run(process.execPath, [join(source, 'scripts/check-cancellation.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  if (process.env.GEAR_TEST_HITCH) {
    note('Installed Hitch execution conditions through the real read-only inspect command')
    run(process.execPath, [join(source, 'scripts/check-hitch-conditions.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  }
  if (process.env.GEAR_TEST_HITCH_ENVIRONMENT) {
    note('Installed provider environment observation through a real zero-job Hitch daemon')
    run(process.execPath, [join(source, 'scripts/check-hitch-environment.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  }
  if (process.env.GEAR_TEST_HITCH_CONTROL) {
    note('Installed cancellation-only connection fences delayed starts in a real zero-job Hitch daemon')
    run(process.execPath, [join(source, 'scripts/check-hitch-control.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  }
  if (process.env.GEAR_TEST_HITCH_PREFLIGHT) {
    note('Installed provider freezes and verifies real native Target artifacts before admission')
    run(process.execPath, [join(source, 'scripts/check-hitch-preflight.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear') } })
  }
  if (process.env.GEAR_TEST_HEADLESS_IMAGE) {
    note('Installed carriers through real DSH/Pi headless CLIs and separate container scoring')
    run(process.execPath, [join(source, 'scripts/check-target-headless.mjs')], { cwd: root, env: { ...env, GEAR_TEST_PACKAGE_ROOT: join(install, 'node_modules/rsi-gear'), GEAR_TEST_HEADLESS_OUTPUT: join(root, 'headless') } })
  }
  const gear = (project, args) => {
    const result = JSON.parse(run(process.execPath, [cli, '--project', project, '--json', ...args], { cwd: root, env }))
    if (args[0] === 'init' && process.env.GEAR_TEST_LINUX_ISOLATION) {
      // Exercise the public compatibility setting on hosts that restrict nested user namespaces.
      const config = join(resolve(project, args[1]), 'gear.yaml')
      writeFileSync(config, readFileSync(config, 'utf8') + '\nsandbox: {linux_isolation: ' + JSON.stringify(process.env.GEAR_TEST_LINUX_ISOLATION) + '}\n')
    }
    return result
  }
  note('Installed setup, profile creation and local doctor')
  const setup = gear(root, ['setup', '--python', python])
  assert.equal(setup.python.status, 'installed')
  const managedEnv = { ...env, GEAR_PYTHON: '', GEAR_TRAINING_TEST_PYTHON: '' }
  const doctorProject = process.env.GEAR_TEST_LINUX_ISOLATION ? join(root, 'doctor-project') : root
  if (doctorProject !== root) gear(root, ['init', doctorProject])
  const prerequisites = JSON.parse(run(process.execPath, [cli, '--project', doctorProject, '--json', 'doctor'], { cwd: root, env: managedEnv }))
  assert.equal(prerequisites.checks.find(check => check.component === 'python').status, 'passed')
  assert.equal(prerequisites.checks.find(check => check.component === 'python').data.executable, setup.python.executable)
  assert.equal(prerequisites.checks.find(check => check.component === 'isolation').status, 'passed', JSON.stringify(prerequisites))
  assert.equal(prerequisites.model_requests, 0)
  assert.equal(prerequisites.ready_for_refine_smoke, false)
  for (const [name, role] of [['default-target', 'target'], ['default-meta', 'meta']]) {
    assert.equal(gear(root, ['profile', 'create', name, '--from', importProfile]).name, name)
    gear(root, ['profile', 'use', name, '--role', role, '--default'])
  }
  assert.equal(gear(root, ['profile', 'list']).profiles.length, 2)
  const checkControlPlane = async (project, check) => {
    const socketPath = join(tmpdir(), `gear-p-${randomUUID().slice(0, 8)}.sock`)
    const child = spawn(process.execPath, [cli, 'serve', '--project', project, '--socket', socketPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    let diagnostic = ''
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000) })
    try {
      await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('Project server startup timed out')), 10000)
        const fail = error => { clearTimeout(timer); reject(error) }
        child.once('error', fail)
        child.once('close', () => fail(new Error(`Project server closed: ${diagnostic}`)))
        child.stdout.on('data', chunk => {
          output += chunk
          if (!output.includes('\n')) return
          try { assert.equal(JSON.parse(output.slice(0, output.indexOf('\n'))).ready, true); clearTimeout(timer); resolve() }
          catch (error) { fail(error) }
        })
      })
      const request = (method, params = {}, id = randomUUID()) => JSON.parse(run(process.execPath, [cli, '--socket', socketPath, 'request', method, JSON.stringify(params), '--request-id', id], { cwd: root, env }))
      assert.deepEqual(request('benchmark.check'), check)
      const before = readdirSync(join(project, '.gear/runs')).length
      const accepted = request('run.evaluate', { split: 'seed', limit: 1 }, 'installed-retry')
      assert.equal(request('run.evaluate', { split: 'seed', limit: 1 }, 'installed-retry').run_id, accepted.run_id)
      let report
      for (let attempt = 0; attempt < 100; attempt++) {
        report = request('run.report', { run_id: accepted.run_id })
        if (report.status === 'completed') break
        assert.notEqual(report.status, 'needs_recovery', JSON.stringify(report))
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(report.status, 'completed')
      assert.equal(report.coverage.physical_attempts, 1)
      assert.equal(readdirSync(join(project, '.gear/runs')).length, before + 1)
      assert.deepEqual(gear(project, ['report', accepted.run_id]), report)
      assert.deepEqual(request('run.archive', { run_id: accepted.run_id }), gear(project, ['archive', accepted.run_id]))
      assert.deepEqual(request('experience.query', { run_id: accepted.run_id }), gear(project, ['experience', 'query', accepted.run_id]))
      assert.deepEqual(request('run.evaluate', { split: 'seed', limit: 1 }, 'installed-retry'), report)
    } finally {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 15000)
      const outcome = await closed
      clearTimeout(force)
      rmSync(`${socketPath}.lock`, { force: true })
      assert.equal(outcome.code, 0, `Project server did not shut down cleanly: ${diagnostic}`)
    }
  }
  // Exercise every public policy bridge using the setup selection, with no override.
  env.GEAR_PYTHON = ''
  env.GEAR_TRAINING_TEST_PYTHON = ''
  for (const target of ['dsh', 'pi']) {
    note('Installed package journey: ' + target)
    const project = join(root, target)
    gear(root, ['init', project, '--target', target, '--template', 'text'])
    writeFileSync(join(project, 'gear.yaml'), readFileSync(join(project, 'gear.yaml'), 'utf8') + '\ngeneration:\n  max_model_requests: 3\n  max_tokens: 400\n  per_operation: {max_model_requests: 1, max_tokens: 128}\n')
    const check = gear(project, ['benchmark', 'check'])
    assert.equal(check.checks.static, 'passed'); assert.equal(check.checks.verifier_fixtures, 'passed')
    assert.equal(check.checks.environment, 'not_run')
    assert.equal(gear(project, ['benchmark', 'preview', 'sum-01']).scorer.expected, '5')
    const smoke = gear(project, ['evaluate', '--split', 'seed', '--limit', '1'])
    assert.equal(smoke.coverage.logical_slots, 1); assert.equal(smoke.coverage.valid_zero, 1)
    const priorRuns = readdirSync(join(project, '.gear/runs')).sort()
    const plan = gear(project, ['refine', '--rounds', '1', '--dry-run'])
    assert.equal(plan.state, 'preview'); assert.equal(plan.run_id, null)
    assert.equal(plan.baseline.reusable_slots, 1); assert.equal(plan.baseline.new_physical_trials, 1)
    assert.equal(plan.baseline.source.run_id, smoke.run_id)
    assert.equal(plan.limits.timeouts.provider.target[0].milliseconds, profile.timeoutMs)
    assert.equal(plan.limits.timeouts.provider.meta[0].milliseconds, profile.timeoutMs)
    assert.equal(plan.limits.timeouts.provider.taskRuntime, 'provider-defined')
    assert.equal(plan.limits.timeouts.task_declarations.groups[0].deadlines.agent_seconds, 600)
    const sdkPlan = JSON.parse(run(isolatedPython, ['-c', 'import asyncio,json;from gear import Project;p=Project.open();plan=p.plan_refine();assert plan==asyncio.run(p.aplan_refine());print(json.dumps(plan))'],
      { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.deepEqual(sdkPlan, plan)
    assert.deepEqual(readdirSync(join(project, '.gear/runs')).sort(), priorRuns)
    writeFileSync(join(project, 'custom_policy.py'), `from gear.algorithms import ParentPlan
def select_parent(view, rng):
    if not view.eligible:
        return ParentPlan.abstain('empty')
    return ParentPlan.single(rng.choice(view.eligible, key='installed-policy'), view.candidate_limit)
select_parent.package_dependencies = ('psutil',)
`)
    const refined = target === 'dsh' ? gear(project, ['refine', '--rounds', '1'])
      : JSON.parse(run(isolatedPython, ['-c', "import json;from gear import Project;from gear.algorithms import GEPA;from custom_policy import select_parent;from gear.algorithms.testkit import test_parent_policy;assert test_parent_policy(select_parent)['status']=='passed';print(json.dumps(Project.open().refine(algorithm=GEPA(parent_policy=select_parent),rounds=1).report.summary))"],
        { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.equal(refined.status, 'completed'); assert.equal(refined.gate.status, 'accepted')
    assert.equal(refined.generation_budget.scope, 'diagnosis-and-generation')
    assert.equal(refined.generation_budget.metrics.model_requests.remaining, 3)
    assert.equal(refined.generation_budget.metrics.tokens.remaining, 400)
    assert.equal(refined.generation_budget.metrics.tokens.unknown_operations, 0)
    const metered = JSON.parse(readFileSync(join(project, '.gear/runs', refined.run_id, 'journal.json'), 'utf8'))
    assert.deepEqual(metered.spec.generationBudget, {version: 1, total: {model_requests: 3, tokens: 400}, perOperation: {model_requests: 1, tokens: 128}})
    const metaOperations = metered.operations.filter(item => ['diagnose_seed', 'generate_candidate'].includes(item.request.operation.kind))
    assert.equal(metaOperations.length, 2)
    for (const item of metaOperations) assert.deepEqual(item.request.generationLimits, {model_requests: 1, tokens: 128})
    assert.equal(refined.coverage.physical_attempts, 7)
    assert.equal(refined.baseline_reuse.source_run_id, smoke.run_id)
    assert.equal(refined.plan.state, 'admitted'); assert.equal(refined.plan.baseline.reusable_slots, 1)
    assert.equal(refined.changes.status, 'available')
    assert.equal(refined.changes.retained.files.length, 1)
    assert.equal(refined.changes.retained.files[0].path, target === 'pi' ? 'AGENTS.md' : 'prompts/system.md')
    assert.match(refined.changes.retained.files[0].patch, /\+offline candidate rule/)
    assert.deepEqual(refined.changes.nominee, refined.changes.retained)
    assert.equal(gear(project, ['resume', refined.run_id]).retained, refined.retained)
    assert.deepEqual(gear(project, ['report', refined.run_id]), refined)
    const research = gear(project, ['archive', refined.run_id])
    assert.equal(research.archive.digest, refined.research.digest)
    assert.equal(research.archive.partition, 'seed')
    assert.equal(research.projection.status, 'available')
    assert.equal(research.projection.value.generations.length, 1)
    assert.ok(research.projection.value.parent_selections.length > 0)
    const sdkResearch = JSON.parse(run(isolatedPython, ['-c', 'import asyncio,json;from gear import Project;p=Project.open();a=p.archive("' + refined.run_id + '");assert a==asyncio.run(p.aarchive("' + refined.run_id + '"));print(json.dumps(a))'],
      { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.deepEqual(sdkResearch, research)
    const experiences = gear(project, ['experience', 'query', refined.run_id])
    assert.equal(experiences.total, 1)
    assert.equal(experiences.items[0].card.classification.effect, 'improved')
    const experienceRef = experiences.items[0].card.ref
    const experienceDiff = gear(project, ['experience', 'read', refined.run_id, experienceRef, '--snapshot', experiences.snapshot_digest, '--view', 'diff'])
    assert.equal(experienceDiff.items[0].path, target === 'pi' ? 'AGENTS.md' : 'prompts/system.md')
    const sdkExperiences = JSON.parse(run(isolatedPython, ['-c', 'import asyncio,json;from gear import Project;p=Project.open();q=p.experience_query("' + refined.run_id + '");assert q==asyncio.run(p.aexperience_query("' + refined.run_id + '"));r=q["items"][0]["card"]["ref"];a=p.experience_read("' + refined.run_id + '",r,view="diff",snapshot=q["snapshot_digest"]);assert a==asyncio.run(p.aexperience_read("' + refined.run_id + '",r,view="diff",snapshot=q["snapshot_digest"]));print(json.dumps({"query":q,"diff":a}))'],
      { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.deepEqual(sdkExperiences, { query: experiences, diff: experienceDiff })
    const modificationUse = gear(project, ['experience', 'read', refined.run_id, experienceRef, '--snapshot', experiences.snapshot_digest, '--view', 'modification-use'])
    assert(modificationUse.items.length > 0)
    assert(modificationUse.items.every(item => item.status === 'unknown' && item.source.coverage === 'unavailable'))
    assert.equal(modificationUse.summary.status_counts.unknown, modificationUse.total)
    assert.equal(modificationUse.summary.conditioned_results.length, 4)
    const sdkModificationUse = JSON.parse(run(isolatedPython, ['-c', `import asyncio,json
from gear import Project
p=Project.open()
args=(${JSON.stringify(refined.run_id)},${JSON.stringify(experienceRef)})
options={"snapshot":${JSON.stringify(experiences.snapshot_digest)},"view":"modification-use"}
value=p.experience_read(*args,**options)
assert value==asyncio.run(p.aexperience_read(*args,**options))
print(json.dumps(value))`], { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.deepEqual(sdkModificationUse, modificationUse)
    const verifier = gear(project, ['experience', 'read', refined.run_id, experienceRef, '--snapshot', experiences.snapshot_digest, '--view', 'verifier'])
    assert(verifier.items.length > 0)
    assert(verifier.items.every(item => item.observation.reason === 'verifier-not-captured'))
    const sdkVerifier = JSON.parse(run(isolatedPython, ['-c', `import asyncio,json
from gear import Project
p=Project.open()
args=(${JSON.stringify(refined.run_id)},${JSON.stringify(experienceRef)})
options={"snapshot":${JSON.stringify(experiences.snapshot_digest)},"view":"verifier"}
value=p.experience_read(*args,**options)
assert value==asyncio.run(p.aexperience_read(*args,**options))
print(json.dumps(value))`], { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.deepEqual(sdkVerifier, verifier)
    run(isolatedPython, ['-c', `import asyncio
from gear import Project
from gear.project import ProjectError
p=Project.open()
params=(${JSON.stringify(refined.run_id)},${JSON.stringify(experienceRef)},"trajectory:"+"f"*64)
for invoke in (lambda: p.experience_trajectory(*params,snapshot=${JSON.stringify(experiences.snapshot_digest)}),lambda: asyncio.run(p.aexperience_trajectory(*params,snapshot=${JSON.stringify(experiences.snapshot_digest)}))):
 try: invoke()
 except ProjectError as error: assert error.code=="trajectory-outside-snapshot",error.code
 else: raise AssertionError("unauthorized historical source was accepted")
`], { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } })
    for (const item of metaOperations) assert.ok(item.request.experience.snapshot_digest.startsWith('sha256:'))
    const exported = gear(project, ['export', refined.run_id])
    assert.deepEqual(gear(project, ['export', refined.run_id]), exported)
    assert.deepEqual(JSON.parse(readFileSync(join(exported.destination, 'report.json'), 'utf8')), refined)
    assert.deepEqual(JSON.parse(readFileSync(join(exported.destination, 'research-archive.json'), 'utf8')), research)
    assert.deepEqual(JSON.parse(readFileSync(join(exported.destination, 'trajectory-sources.json'), 'utf8')), { version: 1, reader: null, sources: [] })
    const exportedExperiences = JSON.parse(readFileSync(join(exported.destination, 'experience-snapshots.json'), 'utf8'))
    assert.equal(exportedExperiences.version, 3)
    assert.equal(exportedExperiences.latest_snapshot_digest, experiences.snapshot_digest)
    assert.deepEqual(exportedExperiences.snapshot_digests, [...new Set(exportedExperiences.snapshot_digests)].sort())
    for (const digest of [experiences.snapshot_digest, ...metaOperations.map(item => item.request.experience.snapshot_digest)])
      assert.ok(exportedExperiences.snapshot_digests.includes(digest))
    const exportedExperienceRoot = join(exported.destination, 'experience'), exportedObjects = new Set()
    for (const digest of exportedExperiences.snapshot_digests) {
      assert.match(digest, /^sha256:[a-f0-9]{64}$/u)
      const snapshot = JSON.parse(readFileSync(join(exportedExperienceRoot, digest.slice(7) + '.json'), 'utf8'))
      assert.equal(snapshot.version, 3)
      assert.equal(snapshot.digest, digest)
      assert.equal(snapshot.run_id, refined.run_id)
      if (digest === experiences.snapshot_digest) {
        assert.equal(snapshot.records.length, 1)
        assert.equal('experience:' + snapshot.records[0].digest.slice(7), experienceRef)
      }
      for (const record of snapshot.records) {
        assert.match(record.descriptor_digest, /^sha256:[a-f0-9]{64}$/u)
        exportedObjects.add(record.descriptor_digest.slice(7) + '.json')
        const descriptor = JSON.parse(readFileSync(join(exportedExperienceRoot, 'objects', record.descriptor_digest.slice(7) + '.json'), 'utf8'))
        assert.equal(descriptor.version, 3)
        assert.equal(descriptor.kind, 'record')
        assert.equal(descriptor.digest, record.descriptor_digest)
        assert.equal(descriptor.record_digest, record.digest)
        assert.equal(descriptor.summary_digest, record.summary_digest)
        assert.equal(descriptor.owner.run_id, refined.run_id)
        for (const [view, chunks] of Object.entries(descriptor.views)) for (const reference of chunks) {
          assert.match(reference.digest, /^sha256:[a-f0-9]{64}$/u)
          exportedObjects.add(reference.digest.slice(7) + '.json')
          const chunk = JSON.parse(readFileSync(join(exportedExperienceRoot, 'objects', reference.digest.slice(7) + '.json'), 'utf8'))
          assert.equal(chunk.version, 3)
          assert.equal(chunk.kind, 'items')
          assert.equal(chunk.digest, reference.digest)
          assert.equal(chunk.view, view)
          assert.equal(chunk.owner.run_id, refined.run_id)
          assert.equal(chunk.items.length, reference.count)
        }
      }
    }
    assert.deepEqual(readdirSync(exportedExperienceRoot).sort(), ['objects', ...exportedExperiences.snapshot_digests.map(digest => digest.slice(7) + '.json')].sort())
    assert.deepEqual(readdirSync(join(exportedExperienceRoot, 'objects')).sort(), [...exportedObjects].sort())
    // Read the export with the installed wheel, without the Project socket or source checkout.
    const exportedSnapshotPath = join(exportedExperienceRoot, experiences.snapshot_digest.slice(7) + '.json')
    for (const [view, expected] of [['diff', experienceDiff], ['verifier', verifier]]) {
      const page = JSON.parse(run(isolatedPython, ['-I', '-B', '-m', 'gear.experience', exportedSnapshotPath], {
        cwd: exported.destination, env, input: JSON.stringify({ action: 'read', ref: experienceRef, view }),
      }))
      assert.deepEqual(page, expected)
    }
    assert.equal(JSON.parse(readFileSync(join(exported.destination, 'baseline-source.json'), 'utf8')).runId, smoke.run_id)
    const sdk = run(isolatedPython, ['-c', 'from gear import Project;p=Project.open();assert p.check()["checks"]["static"]=="passed";assert any(item["name"]=="default-meta" and item["valid"] for item in p.profiles()["profiles"]);p.use_profile("default-meta",role="meta");print(p.report("' + refined.run_id + '").summary["retained"])'],
      { cwd: project, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }).trim()
    assert.equal(sdk, refined.retained)
    const foreground = spawnSync(process.execPath, [cli, '--project', project, 'refine', '--rounds', '1'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(foreground.status, 0, foreground.stderr)
    assert.match(foreground.stderr, /Refine plan \(admitted,/)
    assert.match(foreground.stderr, /Baseline: 2\/2 verified slots reused; 0 new trials needed/)
    const next = JSON.parse(foreground.stdout)
    assert.equal(next.status, 'completed')
    assert.equal(next.coverage.valid_zero, 0, 'The next run must inherit the accepted target content')
    assert.equal(next.coverage.physical_attempts, 0)
    assert.equal(next.baseline_reuse.source_run_id, refined.run_id)
    await checkControlPlane(project, check)
    const journal = JSON.parse(readFileSync(join(project, '.gear/runs', next.run_id, 'journal.json'), 'utf8'))
    assert.equal(journal.spec.lineage.runId, refined.run_id)
    assert.equal(journal.spec.anchor.digest, JSON.parse(readFileSync(join(project, '.gear/champion.json'), 'utf8')).candidate.digest)
    const repairProfile = `repair-${target}`
    writeFileSync(join(profiles, `${repairProfile}.json`), JSON.stringify({ ...profile, configuration: { ...profile.configuration, failInitialEvaluation: true } }))
    const resolved = gear(project, ['config', 'explain']).config
    writeFileSync(join(project, 'gear.yaml'), JSON.stringify({ ...resolved, target: { ...resolved.target, profile: repairProfile }, evaluation: { repair: { max_retries: 1, backoff_ms: [0] } } }))
    const repaired = gear(project, ['evaluate', '--split', 'seed', '--limit', '2'])
    assert.equal(repaired.status, 'completed')
    assert.equal(repaired.coverage.logical_slots, 2)
    assert.equal(repaired.coverage.valid, 2)
    assert.equal(repaired.coverage.physical_attempts, 3)
    assert.equal(repaired.evaluation_repairs.attempts, 1)
    const repairedJournal = JSON.parse(readFileSync(join(project, '.gear/runs', repaired.run_id, 'journal.json'), 'utf8'))
    assert.deepEqual(repairedJournal.spec.evaluationRepair, { maxRetries: 1, maxProjections: 2, backoffMs: [0] })
    assert.equal(repairedJournal.operations[0].receipt.evidence[0].status, 'environment_failed')
    assert.equal(repairedJournal.operations[1].request.slots.length, 1)
    const projectionProfile = `projection-${target}`
    writeFileSync(join(profiles, `${projectionProfile}.json`), JSON.stringify({ ...profile, configuration: { ...profile.configuration, projectEvidence: true } }))
    writeFileSync(join(project, 'gear.yaml'), JSON.stringify({ ...resolved,
      target: { ...resolved.target, profile: projectionProfile },
      evaluation: { repair: { max_retries: 0, max_projections: 1, backoff_ms: [0] } },
      metrics: [{ id: 'fixture_quality', revision: '1', unit: 'points', direction: 'maximize',
        source: { path: 'originalResult.fixture_quality', extractor: 'number-v1' }, granularity: 'trial',
        repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }],
      objective: { terms: [{ metric: 'fixture_quality', weight: 1 }] },
    }))
    const projected = gear(project, ['evaluate', '--split', 'seed', '--limit', '2'])
    assert.equal(projected.status, 'completed')
    assert.equal(projected.coverage.physical_attempts, 2)
    assert.equal(projected.evaluation_repairs.attempts, 0)
    assert.equal(projected.evidence_projections.attempts, 1)
    assert.deepEqual(projected.evidence_projections.blocked, [])
    const projectedJournal = JSON.parse(readFileSync(join(project, '.gear/runs', projected.run_id, 'journal.json'), 'utf8'))
    assert.equal(projectedJournal.operations.length, 2)
    assert.equal(projectedJournal.operations[0].receipt.evidence[0].raw_metrics.fixture_quality, undefined)
    assert.equal(projectedJournal.operations[1].request.projection.rootOperationId, projectedJournal.operations[0].request.operationId)
    const projectedPlan = gear(project, ['refine', '--dry-run'])
    assert.equal(projectedPlan.baseline.reusable_slots, 2)
    assert.equal(projectedPlan.baseline.historical_usage.physical_attempts, 2)
    writeFileSync(join(project, 'gear.yaml'), JSON.stringify({ ...resolved,
      target: { ...resolved.target, profile: projectionProfile },
      evaluation: { repair: { max_retries: 0, max_projections: 1, backoff_ms: [0] } },
      assertions: [{ id: 'independent', revision: '1', source: { path: 'originalResult.fixture_assertion', extractor: 'assertion-status-v1' } }],
      assertion_protection: [{ task_id: 'sum-01', partition: 'seed', assertion_id: 'independent', rule: 'must_pass' }],
    }))
    const asserted = gear(project, ['evaluate', '--split', 'seed', '--limit', '2'])
    assert.equal(asserted.status, 'completed')
    assert.equal(asserted.coverage.physical_attempts, 2)
    assert.equal(asserted.evidence_projections.attempts, 1)
    assert.equal(asserted.scores.initial.seed.score, 1)
    assert.equal(asserted.scores.initial.seed.constraints_passed, false)
    assert.equal(asserted.scores.initial.seed.assertion_protection[0].status, 'failed')
    assert.equal(asserted.scores.initial.seed.assertions[0].values[0].status, 'failed')
    const assertedJournal = JSON.parse(readFileSync(join(project, '.gear/runs', asserted.run_id, 'journal.json'), 'utf8'))
    assert.equal(assertedJournal.operations[0].receipt.evidence[0].assertions, undefined)
    assert.deepEqual(assertedJournal.operations[1].request.projection.missing[0].metrics, [])
    assert.deepEqual(assertedJournal.operations[1].request.projection.missing[0].assertions, ['independent'])
    assert.equal(projectedJournal.operations[1].receipt.physicalAttempts, 0)
    assert.equal(projectedJournal.seedEvidence[0].raw_metrics.fixture_quality.value, 1)
    assert.deepEqual(gear(project, ['resume', projected.run_id]), projected)
    assert.deepEqual(gear(project, ['report', projected.run_id]), projected)
  }
  note('Installed CSV/JSONL and native Harbor import contracts')
  const importedProject = join(root, 'imported-project')
  gear(root, ['init', importedProject, '--target', 'pi'])
  const incoming = join(root, 'incoming.jsonl')
  writeFileSync(incoming, [
    { id: 'import-a', instruction: 'Return A', expected: 'A', family: 'letters' },
    { id: 'import-b', instruction: 'Return 2', expected: '2', family: 'numbers' },
  ].map(row => JSON.stringify(row)).join('\n'))
  const imported = JSON.parse(run(isolatedPython, ['-c', 'import json,sys;from gear import Project;p=Project.open();plan=p.import_benchmark(sys.argv[1]);assert plan["status"]=="review_required";applied=p.apply_benchmark_import(plan["plan_id"]);assert p.check()["tasks"]==2;print(json.dumps(applied))', incoming],
    { cwd: importedProject, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
  assert.equal(imported.status, 'applied')
  if (process.env.GEAR_TEST_BENCHMARK_IMAGE) {
    note('Installed Python SDK and CLI: real Docker scorer probe')
    const probe = JSON.parse(run(isolatedPython, ['-c', 'import json,sys;from gear import Project;print(json.dumps(Project.open().probe_benchmark(scorer=True,image=sys.argv[1])))', process.env.GEAR_TEST_BENCHMARK_IMAGE],
      { cwd: importedProject, env: { ...env, GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.equal(probe.status, 'passed', JSON.stringify(probe))
    assert.equal(probe.model_requests, 0)
    assert.equal(probe.baseline, false)
    assert.deepEqual(probe.fixtures.map(item => item.observed_score), [1, 0])
    assert.deepEqual(probe.cleanup_required, [])
  }
  const importedRun = gear(importedProject, ['evaluate', '--split', 'seed', '--limit', '1'])
  assert.equal(importedRun.status, 'completed')
  assert.equal(importedRun.coverage.valid, 1)
  note('Installed custom Python scorer: static check, preview and frozen contract')
  writeFileSync(join(importedProject, 'scorers.py'), 'import os\nassert "GEAR_TEST_SCORER_SECRET" not in os.environ\ndef score(actual, expected, artifacts, *, seed):\n    return actual == expected and artifacts.get("proof.txt") == "proof" and seed == 7\n')
  writeFileSync(join(importedProject, 'custom-tasks.jsonl'), [
    { id: 'custom-seed', instruction: 'Return OK and write proof.txt', expected: 'OK', split: 'seed' },
    { id: 'custom-held', instruction: 'Return HELD and write proof.txt', expected: 'HELD', split: 'held_out' },
  ].map(row => JSON.stringify(row)).join('\n'))
  const scorer = { entrypoint: 'scorers.py:score', version: 'v1', randomness: { seed: 7 }, cost: { model_requests: 0 }, artifacts: ['proof.txt'] }
  const customConfig = {
    version: 1, source: 'custom-tasks.jsonl', template: 'python', scorer,
    fixtures: Object.fromEntries([['custom-seed', 'OK'], ['custom-held', 'HELD']].map(([id, expected]) => [id, [
      { actual: expected, artifacts: { 'proof.txt': 'proof' }, score: 1 },
      { actual: 'WRONG', artifacts: { 'proof.txt': 'proof' }, score: 0 },
    ]])),
  }
  writeFileSync(join(importedProject, 'custom-benchmark.yaml'), JSON.stringify(customConfig))
  const importedConfig = readFileSync(join(importedProject, 'gear.yaml'), 'utf8')
  writeFileSync(join(importedProject, 'gear.yaml'), importedConfig.replace(/^benchmark:.*$/mu, 'benchmark: custom-benchmark.yaml'))
  const customCheck = gear(importedProject, ['benchmark', 'check'])
  assert.equal(customCheck.checks.verifier_fixtures, 'not_run')
  const customPreview = gear(importedProject, ['benchmark', 'preview', 'custom-seed'])
  assert.equal(customPreview.scorer.rule.scorer.version, 'v1')
  if (process.env.GEAR_TEST_BENCHMARK_IMAGE) {
    note('Installed custom Python scorer: real Docker positive and negative fixtures')
    const customProbe = JSON.parse(run(isolatedPython, ['-c', 'import json,sys;from gear import Project;print(json.dumps(Project.open().probe_benchmark(scorer=True,image=sys.argv[1])))', process.env.GEAR_TEST_BENCHMARK_IMAGE],
      { cwd: importedProject, env: { ...env, GEAR_TEST_SCORER_SECRET: 'must-not-enter-verifier', GEAR_COMMAND: JSON.stringify([process.execPath, cli]) } }))
    assert.equal(customProbe.status, 'passed', JSON.stringify(customProbe))
    assert.equal(customProbe.scorer_metadata.version, 'v1')
    assert.deepEqual(customProbe.scorer_metadata.randomness, { seed: 7 })
    assert.deepEqual(customProbe.fixtures.map(item => item.observed_score), [1, 0])
    assert.deepEqual(customProbe.cleanup_required, [])
  }
  const native = join(root, 'native')
  const nativeImage = process.env.GEAR_TEST_BENCHMARK_IMAGE ?? ('python@sha256:' + '1'.repeat(64))
  for (const id of ['native-a', 'native-b']) {
    mkdirSync(join(native, id, 'environment/candidate'), { recursive: true })
    mkdirSync(join(native, id, 'environment/simulator')); mkdirSync(join(native, id, 'tests'))
    writeFileSync(join(native, id, 'task.toml'), `version="1.0"\nartifacts=[{source="/evidence/snapshot.json",service="simulator"}]\n[metadata]\ncategory="workflow"\ndomain="${id}"\n[verifier]\nenvironment_mode="separate"\n`)
    writeFileSync(join(native, id, 'instruction.md'), 'Native task ' + id)
    writeFileSync(join(native, id, 'environment/candidate/Dockerfile.main'), `FROM ${nativeImage}\nWORKDIR /app\n`)
    writeFileSync(join(native, id, 'environment/simulator/Dockerfile'), `FROM ${nativeImage}\nCMD ["python3", "-m", "http.server", "8765"]\n`)
    writeFileSync(join(native, id, 'environment/docker-compose.yaml'), JSON.stringify({ services: {
      main: { platform: 'linux/amd64', build: { context: 'candidate', dockerfile: 'Dockerfile.main' }, depends_on: { simulator: { condition: 'service_healthy' } }, environment: { API_URL: 'http://simulator:8765' } },
      simulator: { platform: 'linux/amd64', build: { context: 'simulator' }, healthcheck: { test: ['CMD', 'python3', '-c', 'import urllib.request;urllib.request.urlopen("http://localhost:8765")'], interval: '1s', timeout: '3s', retries: 20 } },
    } }))
    writeFileSync(join(native, id, 'tests/Dockerfile'), `FROM ${nativeImage}\nCOPY . /tests\n`)
    writeFileSync(join(native, id, 'tests/test.sh'), '#!/bin/sh\nprintf 1 > /logs/verifier/reward.txt\n')
  }
  run(isolatedPython, ['-c', `import json,sys
from pathlib import Path
from gear.benchmark.native import native_tasks
from gear.benchmark.manifest import build_manifest
root=Path(sys.argv[1]); entries,_,_=native_tasks(root)
score={"source_metric":"correct","direction":"maximize","range":[0,1],"reducer":"task-macro-mean"}
body={"schema_version":"1","kind":"gear-harbor-benchmark","benchmark":{"id":"installed-fixture","revision":"1"},"adapter":{"id":"installed-producer","revision":"1","output_protocol":"gear-harbor-eval-result-v1"},"scoring":{"total_score":score}}
value=build_manifest(body,[{"id":e["task"]["id"],"files":e["files"]} for e in entries])
(root/"benchmark.adapter.json").write_text(json.dumps(value))
(root/"source-manifest.json").write_text(json.dumps({"schema_version":"1","source_commit":"fixture"}))
`, native], { env: { ...env, GEAR_NODE: process.execPath } })
  const nativePlan = gear(importedProject, ['benchmark', 'import', native, '--template', 'harbor'])
  gear(importedProject, ['benchmark', 'import', '--apply', nativePlan.plan_id])
  const nativeCheck = gear(importedProject, ['benchmark', 'check'])
  assert.equal(nativeCheck.tasks, 2)
  assert.equal(nativeCheck.checks.verifier_fixtures, 'not_run')
  const saved = JSON.parse(readFileSync(join(importedProject, '.gear/imports', nativePlan.plan_id + '.json'), 'utf8')).prepared
  assert.equal(saved.version, 2)
  assert.equal(saved.files.every(file => !('content_base64' in file)), true)
  const nativeDestination = join(importedProject, nativePlan.destination, 'tasks')
  assert.equal(readFileSync(join(nativeDestination, 'source-benchmark.adapter.json'), 'utf8'), readFileSync(join(native, 'benchmark.adapter.json'), 'utf8'))
  if (process.env.GEAR_TEST_BENCHMARK_IMAGE) {
    note('Installed native Compose environment: build both services, wait for simulator health and clean up')
    const nativeProbe = gear(importedProject, ['benchmark', 'probe', '--scorer', '--image', nativeImage])
    assert.equal(nativeProbe.environment, 'passed', JSON.stringify(nativeProbe))
    assert.equal(nativeProbe.scorer, 'not_run')
    assert.equal(nativeProbe.status, 'not_run')
    assert.deepEqual(nativeProbe.cleanup_required, [])
  }
  note('Published npm/wheel journey passed (offline provider; real template scorers and OS-sandboxed algorithm)')
} finally {
  if (process.env.GEAR_KEEP_PACKAGE_TEST === '1') note('Kept test artifacts at ' + root)
  else rmSync(root, { recursive: true, force: true })
}
