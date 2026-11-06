import { execFile, spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { GearError } from '../../domain/errors.js'

// A kernel lock has no stale PID files or recovery-election window. The helper
// acquires an inherited open-file description retained by Node. Losing the
// helper alone cannot release ownership while the protected callback runs.
// Parent death closes stdin so the helper releases its remaining descriptor.
const keeper = `
import fcntl, os, sys, time
fd = 3
end = time.monotonic() + 5
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= end: sys.exit(3)
        time.sleep(.02)
print("locked", flush=True)
sys.stdin.buffer.read()
os.close(fd)
`
/** Kernel ownership probe; never infer liveness from a reusable PID. */
export async function fileLockHeld(path: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)(
    process.env.GEAR_LOCK_PYTHON || process.env.GEAR_TRAINING_LOCK_PYTHON || 'python3',
    [
      '-I',
      '-B',
      '-c',
      `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('free')
except BlockingIOError:
    print('held')
`,
      path,
    ],
    { timeout: 10_000, maxBuffer: 1024 },
  )
  if (!['free', 'held'].includes(stdout.trim())) throw new Error('Invalid kernel lock probe')
  return stdout.trim() === 'held'
}
export async function withFileLock<R>(path: string, fn: () => Promise<R>): Promise<R> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const descriptor = await open(path, 'a+', 0o600)
  try {
    const child = spawn(
      process.env.GEAR_LOCK_PYTHON || process.env.GEAR_TRAINING_LOCK_PYTHON || 'python3',
      ['-I', '-B', '-c', keeper],
      { stdio: ['pipe', 'pipe', 'pipe', descriptor.fd] },
    )
    child.stderr!.resume()
    child.stdin!.on('error', () => {})
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new GearError('state-busy', 'state lock timed out; retry the operation'))
        }, 7_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', () => {
          clearTimeout(timer)
          reject(new GearError('state-busy', 'state lock could not be acquired'))
        })
        child.stdout!.on('data', (chunk) => {
          output += chunk
          if (output.includes('locked\n')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      return await fn()
    } finally {
      child.stdin!.end()
      await closed
    }
  } finally {
    await descriptor.close()
  }
}
