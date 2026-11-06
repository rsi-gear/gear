import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const python = process.env.GEAR_LOCK_PYTHON || process.env.GEAR_PYTHON || 'python3'
async function live(pid: number) {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'stat=', '-p', String(pid)]).catch(() => ({
    stdout: '',
  }))
  return Boolean(stdout.trim() && !stdout.trim().startsWith('Z'))
}
for (const cancelled of [false, true])
  it(`reclaims a model's surviving group descendants ${cancelled ? 'on cancellation' : 'after successful leader exit'} before guard acknowledgment`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-guard-test-'))
    roots.push(root)
    const marker = join(root, 'child.pid'),
      guard = spawn(python, ['-I', '-B', resolve('assets/codex-process-guard.py')], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
    let ack = '',
      stderr = ''
    guard.stdio[3]!.on('data', (chunk) => {
      ack += chunk.toString()
    })
    guard.stderr!.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const finished = new Promise<number | null>((resolve, reject) => {
      guard.once('error', reject)
      guard.once('close', resolve)
    })
    const code = `import errno,os,subprocess,sys,time\ntry:\n os.write(3,b'forged')\n raise Exception('model inherited guard acknowledgment')\nexcept OSError as error:\n assert error.errno==errno.EBADF\nchild=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen(sys.argv[1],'w').write(str(child.pid))\n${cancelled ? 'time.sleep(60)' : ''}\n`
    guard.stdin!.write(
      JSON.stringify({
        argv: [python, '-I', '-B', '-c', code, marker],
        cwd: root,
        env: { PATH: process.env.PATH },
        prompt: '',
        cleanupRoot: root,
        timeoutMs: 5000,
      }) + '\n',
    )
    let descendant = 0
    let cancellation: NodeJS.Timeout | undefined
    try {
      await expect
        .poll(
          async () => {
            descendant = Number(await readFile(marker, 'utf8').catch(() => '0'))
            return descendant > 0
          },
          { timeout: 5000 },
        )
        .toBe(true)
      if (cancelled) {
        guard.kill('SIGTERM')
        cancellation = setInterval(() => guard.kill('SIGTERM'), 5)
      }
      expect(await finished, stderr).toBe(cancelled ? 137 : 0)
      expect(JSON.parse(ack)).toEqual({ version: 1, model_stopped: true, returncode: cancelled ? 137 : 0 })
      await expect.poll(() => live(descendant), { timeout: 3000 }).toBe(false)
    } finally {
      if (cancellation) clearInterval(cancellation)
      guard.stdin!.destroy()
      if (guard.exitCode === null && guard.signalCode === null) guard.kill('SIGKILL')
      if (descendant && (await live(descendant))) process.kill(descendant, 'SIGKILL')
    }
  })
it('acknowledges a successful leader with no surviving descendants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-guard-test-'))
  roots.push(root)
  const guard = spawn(python, ['-I', '-B', resolve('assets/codex-process-guard.py')], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  let ack = '',
    stderr = ''
  guard.stdio[3]!.on('data', (chunk) => {
    ack += chunk.toString()
  })
  guard.stderr!.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const finished = new Promise<number | null>((resolve, reject) => {
    guard.once('error', reject)
    guard.once('close', resolve)
  })
  guard.stdin!.write(
    JSON.stringify({
      argv: [python, '-I', '-B', '-c', 'pass'],
      cwd: root,
      env: {},
      prompt: '',
      cleanupRoot: root,
      timeoutMs: 5000,
    }) + '\n',
  )
  try {
    expect(await finished, stderr).toBe(0)
    expect(JSON.parse(ack)).toEqual({ version: 1, model_stopped: true, returncode: 0 })
  } finally {
    guard.stdin!.destroy()
  }
})
it('rejects a nonleader --worker before admitting any model execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-guard-test-'))
  roots.push(root)
  const { dedicatedWorkerShutdown } = await import('../../src/adapters/codex/cleanup.js')
  // Vitest is not the leader of a detached operation group; library inspection never signals it.
  const shutdown = await dedicatedWorkerShutdown()
  expect(() => shutdown.assertOwnership()).toThrow('Worker must own a separate process group')
  await mkdir(join(root, 'kept'))
})
