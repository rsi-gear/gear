import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bootstrap } from '../prepare.mjs'
import { command } from '../common.mjs'
import { compilerEnvironment } from '../start.mjs'
import { SubprocessHarnessCompiler } from '../../../lib/harness/compiler.js'
import { acquireAirGappedSandbox } from '../../../lib/sandbox.js'

test('compiler environment preserves explicit settings and resolves macOS native Git narrowly', async () => {
  const config = await compilerEnvironment({ env: { PATH: '/usr/bin:/bin', CHECK_OPTION: 'fixed' }, readPaths: ['/fixed/toolchain'] })
  assert.equal(config.env.CHECK_OPTION, 'fixed')
  assert.equal(config.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(config.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.ok(config.readPaths.includes('/fixed/toolchain'))
  if (process.platform === 'darwin') {
    const git = await realpath(await command('/usr/bin/xcrun', ['--find', 'git']))
    assert.equal(config.env.PATH.split(':')[0], dirname(git))
    assert.ok(config.readPaths.includes(git))
    assert.ok(!config.readPaths.includes('/Library/Developer'))
    assert.ok(!config.readPaths.includes('/var/select'))
  } else assert.equal(config.env.PATH, '/usr/bin:/bin')
})

test('macOS fixed carrier checker passes inside the required compiler sandbox', { skip: process.platform !== 'darwin' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-kaggle-compiler-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = await bootstrap(join(root, 'target'))
  const toolchain = await compilerEnvironment({ env: { PATH: '/usr/bin:/bin' }, readPaths: [project.targetRepository] })
  const lease = await acquireAirGappedSandbox('seccomp', 'Kaggle compiler test')
  try {
    const compiler = new SubprocessHarnessCompiler({ command: process.execPath,
      args: [join(project.targetRepository, 'fixed/check.mjs')], ...toolchain,
      timeoutMs: 30000, sandboxMode: 'required', linuxIsolation: 'seccomp', targetRoot: 'harness' })
    const report = await compiler.compile(project.targetRepository, AbortSignal.timeout(30000))
    assert.equal(report.ok, true)
    assert.equal(report.runtime.load.status, 'not_checked', 'this checks the fixed compiler, not ML runtime validation')
  } finally { await lease.release() }
})
