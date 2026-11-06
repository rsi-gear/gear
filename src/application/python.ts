import {
  managedPythonRoot,
  pythonSourceRoot,
  resolvePythonExecutable,
} from '../adapters/python/interpreter.js'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { publishFile } from '../adapters/storage/atomic.js'
import { withFileLock } from '../adapters/storage/file-lock.js'
import { GearError } from '../domain/errors.js'
import { benchmarkLimits } from '../adapters/python/benchmark-limits.js'
const execute = promisify(execFile)
const defaultAuthorTimeoutMs = 60_000
const defaultMaxOutputBytes = 128 * 1024 * 1024
const activeAuthors = new Set<(reason: GearError) => void>()
const interruptAuthors = () => terminateAuthors('SIGINT', interruptAuthors)
const terminateAuthorProcesses = () => terminateAuthors('SIGTERM', terminateAuthorProcesses)
function stopAuthors() {
  for (const stop of activeAuthors)
    stop(new GearError('python-interrupted', 'Python author tool interrupted'))
}
function terminateAuthors(signal: NodeJS.Signals, listener: () => void) {
  // Prepend our listener so existing once-handlers still count before they run.
  const defaultTermination = process.listenerCount(signal) === 1
  stopAuthors()
  if (defaultTermination) {
    process.off(signal, listener)
    process.kill(process.pid, signal)
  }
}
function trackAuthor(stop: (reason: GearError) => void): () => void {
  if (!activeAuthors.size) {
    process.prependListener('SIGINT', interruptAuthors)
    process.prependListener('SIGTERM', terminateAuthorProcesses)
    process.on('exit', stopAuthors)
  }
  activeAuthors.add(stop)
  return () => {
    activeAuthors.delete(stop)
    if (!activeAuthors.size) {
      process.off('SIGINT', interruptAuthors)
      process.off('SIGTERM', terminateAuthorProcesses)
      process.off('exit', stopAuthors)
    }
  }
}
export { packageRoot, pythonSourceRoot, managedPythonRoot } from '../adapters/python/interpreter.js'
export async function pythonExecutable(): Promise<string> {
  return resolvePythonExecutable()
}
export async function pythonJson(args: string[], input: unknown, signal?: AbortSignal): Promise<unknown> {
  const python = await pythonExecutable()
  const { spawn } = await import('node:child_process')
  signal?.throwIfAborted()
  const limits = args[0] === 'benchmark' ? benchmarkLimits() : undefined
  const timeoutMs = limits?.authorTimeoutMs ?? defaultAuthorTimeoutMs
  const maxOutputBytes = limits?.maxOutputBytes ?? defaultMaxOutputBytes
  const payload = JSON.stringify(input)
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'gear', ...args], {
      env: { ...process.env, PYTHONPATH: pythonSourceRoot, GEAR_NODE: process.execPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const chunks: Buffer[] = []
    let outputBytes = 0,
      stderr = ''
    let failure: unknown
    const stop = (error: unknown) => {
      failure ??= error
      if (child.pid) {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') failure = killError
        }
      }
    }
    const abort = () => stop(signal!.reason)
    const releaseAuthor = trackAuthor(stop)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () =>
        stop(
          new GearError(
            'python-timeout',
            limits
              ? 'Benchmark author tool timed out; adjust authorTimeoutMs in GEAR_BENCHMARK_LIMITS_JSON'
              : 'Python author tool timed out',
          ),
        ),
      timeoutMs,
    )
    child.on('error', (error) => {
      failure ??= error
    })
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        stop(new GearError('python-output-limit', 'Python author tool exceeded its output byte budget'))
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16_000)
    })
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      releaseAuthor()
      // Wait for close before settling: a timeout is not evidence the child stopped.
      if (failure !== undefined) {
        reject(failure)
        return
      }
      if (code !== 0) {
        try {
          const failure = JSON.parse(stderr) as { code?: unknown; message?: unknown; location?: unknown }
          if (typeof failure.code === 'string' && typeof failure.message === 'string') {
            reject(
              new GearError(
                failure.code,
                failure.message,
                typeof failure.location === 'string' ? { location: failure.location } : {},
              ),
            )
            return
          }
        } catch {
          /* A crash may not produce an authoring error envelope. */
        }
        reject(
          new GearError('python-command-failed', 'Python author tool failed without a structured diagnostic'),
        )
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new GearError('python-invalid-response', 'Python command did not return valid JSON'))
      }
    })
    child.stdin.end(payload)
  })
}
export async function setupPython(
  executable = process.env.GEAR_SETUP_PYTHON ?? 'python3.12',
): Promise<unknown> {
  const version = await execute(
    executable,
    ['-c', 'import sys;assert sys.version_info >= (3,10);print(".".join(map(str,sys.version_info[:3])))'],
    { timeout: 10_000, maxBuffer: 4096 },
  )
  const root = managedPythonRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  return withFileLock(join(root, '.install.lock'), async () => {
    const directory = await mkdtemp(join(root, 'env-'))
    const python = join(directory, 'bin/python')
    try {
      await execute(executable, ['-m', 'venv', directory], { timeout: 60_000, maxBuffer: 64 * 1024 })
      await execute(python, ['-m', 'pip', 'install', pythonSourceRoot], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 300_000,
      })
      await execute(
        python,
        [
          '-I',
          '-c',
          'import gear,psutil,tomli_w;import gear.benchmark.native;from gear.algorithms import GEPA;from gear.algorithms.testkit import toy_round;assert toy_round(GEPA())["status"]=="passed"',
        ],
        { timeout: 30_000, maxBuffer: 64 * 1024 },
      )
      // Keep the venv at its original path: installed script shebangs reference it.
      await publishFile(
        join(root, 'current.json'),
        JSON.stringify({ environment: directory.slice(root.length + 1) }) + '\n',
      )
    } catch {
      await rm(directory, { recursive: true, force: true })
      throw new GearError(
        'python-setup-failed',
        'Managed Python installation failed; the previous environment remains selected',
        { next_action: 'Check Python and package-index access, then rerun gear setup' },
      )
    }
    return { status: 'installed', executable: python, version: version.stdout.trim() }
  })
}
