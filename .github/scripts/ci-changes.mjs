import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const allJobs = { code: true, macos: true }
const documentationScripts = new Set([
  'scripts/render-guide-charts.py',
  'scripts/package-guide-examples.py',
])
const macosTests = new Set([
  'tests/integration/sandbox-platform.spec.ts',
  'tests/unit/sandbox.spec.ts',
  'tests/unit/notebook-runtime.spec.ts',
])

function isDocumentation(path) {
  // Markdown under skills/ and examples/ is executable product input.
  return /^README(?:\.[^/]+)?\.md$/u.test(path)
    || /^docs\/.*\.(?:md|txt|png|svg|jpe?g|gif|webp|json|zip)$/u.test(path)
    || documentationScripts.has(path)
}

function affectsMacos(path) {
  if (macosTests.has(path) || /^tests\/(?:helpers|fixtures|e2e)\//u.test(path)) return true
  // These suites and examples do not run in test:sandbox:platform. Keep all
  // src/, assets/, skills/, build/configuration and unknown paths conservative.
  return !/^(?:python|tests|examples|docs)\//u.test(path)
}

export function selectJobs(paths, { full = false } = {}) {
  if (full || paths === null) return { ...allJobs }
  const codePaths = paths.filter(path => !isDocumentation(path))
  return {
    code: codePaths.length > 0,
    macos: codePaths.some(affectsMacos),
  }
}

export function selectWorkflowJobs(eventName, event, paths) {
  const manual = eventName === 'workflow_dispatch'
  const jobs = selectJobs(paths, { full: manual })
  return {
    ...jobs,
    full_tests: jobs.code && (manual
      || (eventName === 'pull_request' && event.pull_request?.base?.ref === 'main')
      || (eventName === 'push' && event.ref === 'refs/heads/main')),
  }
}

export function changedPaths(eventName, event, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  let base
  let head
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha
    head = event.pull_request?.head?.sha
  } else if (eventName === 'push') {
    base = event.before
    head = event.after
  } else {
    return null
  }
  // New branches, missing history and unknown events select all platform jobs.
  // The full regression suite still follows the main/manual event policy.
  if (![base, head].every(sha => /^[a-f0-9]{40}$/u.test(sha ?? '') && !/^0+$/u.test(sha))) return null
  try {
    if (eventName === 'pull_request') base = git(['merge-base', base, head]).trim()
    // --no-renames includes both sides of a rename, so moving code to docs
    // cannot hide the removal of a runtime file. NUL handles unusual filenames.
    return git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean)
  } catch {
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const paths = changedPaths(process.env.GITHUB_EVENT_NAME, event)
  const jobs = selectWorkflowJobs(process.env.GITHUB_EVENT_NAME, event, paths)
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(jobs).map(([key, value]) => `${key}=${value}\n`).join(''))
  const comparison = paths === null
    ? 'Manual/unknown event, new branch or unavailable comparison.'
    : `Compared ${paths.length} changed paths.`
  const summary = `${comparison} Linux jobs: ${jobs.code}; macOS: ${jobs.macos}; full regression tests: ${jobs.full_tests}.`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}
