import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { changedPaths, selectJobs, selectWorkflowJobs } from './ci-changes.mjs'

test('documentation-only changes skip heavy jobs, but mixed changes keep them', () => {
  const docs = ['README.md', 'README.zh-CN.md', 'docs/guide/zh-CN/index.md',
    'docs/guide/assets/chart.svg', 'docs/guide/manifest.json', 'scripts/render-guide-charts.py']
  assert.deepEqual(selectJobs(docs), { code: false, macos: false })
  assert.deepEqual(selectJobs([...docs, 'src/sandbox.ts']), { code: true, macos: true })
  assert.deepEqual(selectJobs([]), { code: false, macos: false })
})

test('platform tests retain runtime, fixture, dependency and configuration coverage', () => {
  for (const path of ['src/sandbox.ts', 'src/refine/service.ts', 'assets/ipython-kernel.py',
    'skills/refine/references/protocol.md', 'tests/unit/notebook-runtime.spec.ts',
    'tests/unit/sandbox.spec.ts', 'tests/integration/sandbox-platform.spec.ts',
    'tests/helpers/git-fixture.ts', 'tests/fixtures/notebook-helper.py',
    'tests/e2e/refine-skill.e2e.spec.ts', 'package.json', 'package-lock.json',
    'vitest.config.ts', 'tsconfig.json', 'scripts/build-private-tool-fs.mjs',
    '.github/workflows/ci.yml', '.github/scripts/ci-changes.mjs', 'new-config.yml']) {
    assert.deepEqual(selectJobs([path]), { code: true, macos: true }, path)
  }
})

test('the macOS selection covers every test entry in the package script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const entries = pkg.scripts['test:sandbox:platform'].split(/\s+/u).filter(arg => arg.startsWith('tests/'))
  assert.ok(entries.length > 0)
  for (const path of entries) assert.equal(selectJobs([path]).macos, true, path)
})

test('Python, other test suites and examples keep Linux validation without macOS', () => {
  for (const path of ['python/gear_training/controller.py', 'tests/unit/refine-service.spec.ts',
    'tests/integration/dsh-runtime-check.spec.ts', 'examples/dsh-codex-luna/bootstrap-target.mjs',
    'examples/dsh-codex-luna/README.md', 'docs/example.ts']) {
    assert.deepEqual(selectJobs([path]), { code: true, macos: false }, path)
  }
})

test('manual runs and unavailable comparisons select all platform jobs', () => {
  assert.deepEqual(selectJobs(['README.md'], { full: true }), { code: true, macos: true })
  assert.deepEqual(selectJobs(null), { code: true, macos: true })
  assert.equal(changedPaths('workflow_dispatch', {}), null)
  assert.equal(changedPaths('push', { before: '0'.repeat(40), after: '1'.repeat(40) }), null)
  assert.equal(changedPaths('push', { before: 'bad-ref', after: '1'.repeat(40) }), null)
  assert.equal(changedPaths('push', { before: '1'.repeat(40), after: '2'.repeat(40) }, () => {
    throw new Error('missing history')
  }), null)
})

test('dev code changes keep quick checks but defer full regression tests to main', () => {
  const paths = ['src/refine/service.ts']
  assert.deepEqual(selectWorkflowJobs('push', { ref: 'refs/heads/dev' }, paths),
    { code: true, macos: true, full_tests: false })
  // A PR's target branch determines the policy, not its source branch.
  assert.equal(selectWorkflowJobs('pull_request', { pull_request: {
    base: { ref: 'dev' }, head: { ref: 'main' },
  } }, paths).full_tests, false)
  assert.equal(selectWorkflowJobs('pull_request', { pull_request: {
    base: { ref: 'main' }, head: { ref: 'dev' },
  } }, paths).full_tests, true)
  assert.equal(selectWorkflowJobs('push', { ref: 'refs/heads/main' }, paths).full_tests, true)
  assert.equal(selectWorkflowJobs('push', { ref: 'refs/heads/not-main' }, paths).full_tests, false)
})

test('docs still skip heavy checks while manual runs always include the full suite', () => {
  assert.deepEqual(selectWorkflowJobs('push', { ref: 'refs/heads/main' }, ['README.md']),
    { code: false, macos: false, full_tests: false })
  assert.deepEqual(selectWorkflowJobs('workflow_dispatch', { ref: 'refs/heads/dev' }, ['README.md']),
    { code: true, macos: true, full_tests: true })
  assert.equal(selectWorkflowJobs('push', { ref: 'refs/heads/main' }, null).full_tests, true)
  assert.equal(selectWorkflowJobs('push', { ref: 'refs/heads/dev' }, null).full_tests, false)
})

test('real git comparisons cover whole pushes, PR merge bases, deletions and renames', () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-ci-paths-'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commit = () => {
    git(['add', '--all'])
    git(['commit', '-qm', 'fixture'])
    return git(['rev-parse', 'HEAD']).trim()
  }
  try {
    git(['init', '-q', '-b', 'base'])
    git(['config', 'user.name', 'CI test'])
    git(['config', 'user.email', 'ci-test@example.invalid'])
    git(['config', 'commit.gpgsign', 'false'])
    write('src/sandbox.ts', 'export const mode = 1\n')
    const base = commit()
    git(['checkout', '-qb', 'topic'])
    write('src/sandbox.ts', 'export const mode = 2\n')
    commit()
    write('README.md', 'documentation\n')
    const head = commit()
    const pushPaths = changedPaths('push', { before: base, after: head }, git)
    assert.deepEqual(new Set(pushPaths), new Set(['README.md', 'src/sandbox.ts']))
    git(['checkout', '-q', 'base'])
    write('base-only.txt', 'unrelated base change\n')
    const advancedBase = commit()
    const prPaths = changedPaths('pull_request', { pull_request: {
      base: { sha: advancedBase }, head: { sha: head },
    } }, git)
    assert.deepEqual(new Set(prPaths), new Set(pushPaths))
    git(['checkout', '-q', 'topic'])
    mkdirSync(join(root, 'docs'), { recursive: true })
    git(['mv', 'src/sandbox.ts', 'docs/moved.md'])
    write('docs/odd\nname.md', 'unusual filename\n')
    const renamed = commit()
    const renamePaths = changedPaths('push', { before: head, after: renamed }, git)
    assert.deepEqual(new Set(renamePaths), new Set(['src/sandbox.ts', 'docs/moved.md', 'docs/odd\nname.md']))
    assert.deepEqual(selectJobs(renamePaths), { code: true, macos: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
