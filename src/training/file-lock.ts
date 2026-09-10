import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TrainingContractError } from './schema.js'

// A kernel lock has no stale PID files or recovery-election window. The helper
// holds it until stdin closes; the OS releases it if either process disappears.
const keeper = `
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
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
export async function withTrainingFileLock<R>(path: string, fn: () => Promise<R>): Promise<R> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const child = spawn(process.env.GEAR_TRAINING_LOCK_PYTHON || 'python3', ['-c', keeper, path], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()) })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new TrainingContractError('state-busy', 'state lock timed out; retry the operation')) }, 7_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', () => { clearTimeout(timer); reject(new TrainingContractError('state-busy', 'state lock could not be acquired')) })
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('locked\n')) { clearTimeout(timer); resolve() } })
    })
    return await fn()
  } finally { child.stdin.end(); await closed }
}
