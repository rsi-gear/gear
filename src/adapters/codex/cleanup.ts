import { execFile } from 'node:child_process'
import { lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { GearError } from '../../domain/errors.js'
import { publishFile } from '../storage/atomic.js'

export interface CodexWorkerLifecycle {
  assertOwnership(): void
  modelStarted(): void
  modelStopped(): void
  beginCleanup(): void
  group: number
}
export interface CodexResources {
  root?: { path: string; parent: string; dev: number; ino: number }
  dispose?: () => Promise<void>
}
type CleanupStep = 'complete' | 'timed-out' | 'failed' | 'unconfirmed'
export const CODEX_CLEANUP_DEADLINE_MS = 4500

export async function ownCodexRoot(path: string): Promise<NonNullable<CodexResources['root']>> {
  const parent = await realpath(tmpdir()),
    info = await lstat(path)
  if (
    dirname(path) !== parent ||
    !/^gear-meta-[A-Za-z0-9]+$/u.test(basename(path)) ||
    !info.isDirectory() ||
    info.isSymbolicLink()
  )
    throw new GearError('codex-root-invalid', 'Invalid owned sandbox root')
  return { path, parent, dev: info.dev, ino: info.ino }
}
async function removeOwnedRoot(root: NonNullable<CodexResources['root']>, home = false) {
  const info = await lstat(root.path)
  if (
    (await realpath(dirname(root.path))) !== root.parent ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== root.dev ||
    info.ino !== root.ino
  )
    throw new GearError('codex-root-invalid', 'Sandbox root ownership changed')
  // fs.rm uses lstat for descendants: a model-replaced home/.codex symlink is unlinked, not followed.
  await rm(home ? join(root.path, 'home') : root.path, { recursive: true, force: true })
}
async function bounded(action: () => Promise<unknown>, milliseconds: number): Promise<CleanupStep> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), milliseconds)
    void Promise.resolve()
      .then(action)
      .then(
        () => {
          clearTimeout(timer)
          resolve('complete')
        },
        () => {
          clearTimeout(timer)
          resolve('failed')
        },
      )
  })
}
/** Graceful attempts are bounded; the dedicated worker's exit is the final socket ownership boundary. */
export async function cleanupCodex(
  directory: string,
  digest: string,
  resources: CodexResources,
  modelStopped = true,
): Promise<void> {
  await bounded(
    () =>
      publishFile(
        join(directory, 'cleanup-started.json'),
        JSON.stringify({
          version: 1,
          input_digest: digest,
          worker_exit: 'required',
        }),
        { immutable: true },
      ),
    250,
  )
  const credentials = modelStopped
    ? await bounded(() => (resources.root ? removeOwnedRoot(resources.root, true) : Promise.resolve()), 500)
    : 'unconfirmed'
  const gateway = await bounded(() => resources.dispose?.() ?? Promise.resolve(), 500)
  const sandbox = await bounded(() => SandboxManager.reset(), 1500)
  const root = modelStopped
    ? await bounded(() => (resources.root ? removeOwnedRoot(resources.root) : Promise.resolve()), 1000)
    : 'unconfirmed'
  const stages = { gateway, credentials, sandbox, root }
  await bounded(
    () =>
      publishFile(
        join(directory, 'cleanup.json'),
        JSON.stringify({
          version: 1,
          input_digest: digest,
          status: Object.values(stages).every((stage) => stage === 'complete')
            ? 'graceful'
            : 'fallback-required',
          stages,
          model_stopped: modelStopped,
          worker_exit: 'required',
        }),
        { immutable: true },
      ),
    250,
  )
}

/** Only the detached --worker CLI can terminate a verified group; library callers never do. */
export async function dedicatedWorkerShutdown() {
  const { stdout } = await promisify(execFile)(
    process.env.GEAR_LOCK_PYTHON || 'python3',
    ['-I', '-B', '-c', 'import os;print(os.getpgrp())'],
    { timeout: 1000, maxBuffer: 128 },
  )
  const owned = Number(stdout.trim()) === process.pid
  let stopped = true,
    timer: NodeJS.Timeout | undefined
  const exit = (code: number) => {
    if (timer) clearTimeout(timer)
    if (!owned) {
      // No-op duplicate workers have no resources; let the asset report validation errors.
      process.exitCode = code
      return
    }
    if (stopped) {
      // This live worker PID is its verified group ID, never the parent task's group.
      try {
        process.kill(-process.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    // Unknown models retain their guard: EOF makes it finish its own cleanup.
    process.exit(code)
  }
  return {
    group: process.pid,
    assertOwnership() {
      if (!owned)
        throw new GearError('codex-worker-group-invalid', 'Worker must own a separate process group')
    },
    modelStarted() {
      stopped = false
    },
    modelStopped() {
      stopped = true
    },
    beginCleanup() {
      if (!stopped || timer) return
      // Ref'ed, and armed only after receipt publication was attempted.
      timer = setTimeout(() => exit(1), CODEX_CLEANUP_DEADLINE_MS)
    },
    exit,
  }
}
