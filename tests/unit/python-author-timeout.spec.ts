import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pythonJson } from '../../src/application/python.js'

let root: string
let controller: AbortController
let operation: Promise<unknown> | undefined
const deadlines = new Map<number, () => void>()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-author-deadline-'))
  controller = new AbortController()
  const executable = join(root, 'python.cjs')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.GEAR_AUTHOR_FIXTURE_ROOT;
let child;
if (process.env.GEAR_AUTHOR_FIXTURE_CHILD === '1') {
  child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
}
const watcher = fs.watch(root, () => {
  if (!fs.existsSync(path.join(root, 'release'))) return;
  watcher.close();
  console.log(JSON.stringify({ok: true}));
});
fs.writeFileSync(path.join(root, 'ready'), JSON.stringify({pid:process.pid, child:child?.pid}));
process.stdin.resume();
`, { mode: 0o700 })
  vi.stubEnv('GEAR_PYTHON', executable)
  vi.stubEnv('GEAR_AUTHOR_FIXTURE_ROOT', root)
  vi.stubEnv('GEAR_BENCHMARK_LIMITS_JSON', '{}')
  const schedule = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    deadlines.set(ms ?? 0, () => callback(...args))
    return schedule(callback, ms, ...args)
  }) as typeof setTimeout)
})
afterEach(async () => {
  controller.abort()
  await operation?.catch(() => {})
  operation = undefined
  vi.restoreAllMocks()
  deadlines.clear()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function launch(args = ['benchmark', 'compile']) {
  operation = pythonJson(args, {}, controller.signal).catch((error: unknown) => error)
  let ready: { pid: number; child?: number } | undefined
  await vi.waitFor(async () => { ready = JSON.parse(await readFile(join(root, 'ready'), 'utf8')) }, { timeout: 5000 })
  return ready!
}

it('gives benchmark authoring the shared preparation deadline and allows normal completion', async () => {
  const { pid } = await launch()
  expect(deadlines.has(300_000)).toBe(true)
  expect(deadlines.has(60_000)).toBe(false)
  expect(() => process.kill(pid, 0)).not.toThrow()
  await writeFile(join(root, 'release'), '')
  expect(await operation).toEqual({ ok: true })
})

it.each(['benchmark', 'algorithm'])('stops %s authoring at its own deadline and waits for process exit', async (command) => {
  vi.stubEnv('GEAR_BENCHMARK_LIMITS_JSON', '{"authorTimeoutMs":10000}')
  const { pid } = await launch([command, 'compile'])
  deadlines.get(command === 'benchmark' ? 10_000 : 60_000)!()
  expect(await operation).toMatchObject({ code: 'python-timeout' })
  expect(() => process.kill(pid, 0)).toThrow()
})

it('enforces the configured benchmark output budget', async () => {
  vi.stubEnv('GEAR_BENCHMARK_LIMITS_JSON', '{"maxOutputBytes":8}')
  await launch()
  await writeFile(join(root, 'release'), '')
  expect(await operation).toMatchObject({ code: 'python-output-limit' })
})

it.skipIf(process.platform !== 'linux')('cancels the author and its child process group', async () => {
  vi.stubEnv('GEAR_AUTHOR_FIXTURE_CHILD', '1')
  const ready = await launch()
  controller.abort(new Error('fixture cancellation'))
  expect(await operation).toMatchObject({ message: 'fixture cancellation' })
  expect(() => process.kill(ready.pid, 0)).toThrow()
  await vi.waitFor(async () => {
    try {
      const state = await readFile(`/proc/${ready.child}/stat`, 'utf8')
      expect(state.slice(state.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })
})

it.skipIf(process.platform !== 'linux').each(['SIGINT', 'SIGTERM', 'exit'] as const)(
  'stops detached author processes when their caller receives %s', async (mode) => {
    vi.stubEnv('GEAR_AUTHOR_FIXTURE_CHILD', '1')
    const module = new URL('../../lib/application/python.js', import.meta.url).href
    const caller = spawn(process.execPath, ['--input-type=module', '-e', `
import { pythonJson } from ${JSON.stringify(module)};
process.on('message', () => process.exit(23));
await pythonJson(['benchmark', 'compile'], {});
`], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const closed = once(caller, 'close')
    let ready: { pid: number; child: number } | undefined
    try {
      await vi.waitFor(async () => { ready = JSON.parse(await readFile(join(root, 'ready'), 'utf8')) }, { timeout: 5000 })
      if (mode === 'exit') caller.send('exit')
      else caller.kill(mode)
      const [code, signal] = await closed
      if (mode === 'exit') expect(code).toBe(23)
      else expect(signal).toBe(mode)
      for (const pid of [ready!.pid, ready!.child]) {
        await vi.waitFor(async () => {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
            expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        })
      }
    } finally {
      caller.kill('SIGKILL')
      if (ready) {
        try { process.kill(-ready.pid, 'SIGKILL') } catch {}
      }
      await closed
    }
  },
)
