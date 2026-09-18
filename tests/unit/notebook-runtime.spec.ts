import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionAwareNotebookRuntime } from '../../src/notebook/runtime.js'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'

const runtimes: SessionAwareNotebookRuntime[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SessionAwareNotebookRuntime', () => {
  it('keeps one isolated persistent IPython namespace per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-'))
    roots.push(root)
    const runtime = new SessionAwareNotebookRuntime({
      helperPath: fileURLToPath(new URL('../fixtures/notebook-helper.py', import.meta.url)),
    })
    runtimes.push(runtime)
    await runtime.execute({ sessionId: 'a', cwd: root, role: 'rollout', code: 'value = 40' })
    const a = await runtime.execute({ sessionId: 'a', cwd: root, role: 'rollout', code: 'value + 2' })
    expect(a.result).toBe('42')
    await expect(runtime.execute({ sessionId: 'b', cwd: root, role: 'rollout', code: 'value' })).rejects.toThrow(/NameError/)
  })

  it('exposes only role-allowed host bridge methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-'))
    roots.push(root)
    const calls: string[] = []
    const runtime = new SessionAwareNotebookRuntime({
      helperPath: fileURLToPath(new URL('../fixtures/notebook-helper.py', import.meta.url)),
      allowedMethods: { 'refine-meta': ['harness.current', 'candidate.finalize'], rollout: [] },
      bridge: async (method) => { calls.push(method); return method === 'candidate.finalize' ? { accepted: true } : { ok: true } },
    })
    runtimes.push(runtime)
    const result = await runtime.execute({
      sessionId: 'meta', cwd: root, role: 'refine-meta',
      code: "harness.current(); candidate.finalize(rationale='r', expectedOutcome='x', evidenceRefs=['e'])",
    })
    expect(calls).toEqual(['harness.current', 'candidate.finalize'])
    expect(result.concludesTurn).toBe(true)
    await expect(runtime.execute({
      sessionId: 'rollout', cwd: root, role: 'rollout', code: 'harness.current()',
    })).rejects.toThrow(/PermissionError/)
  })

  it('keeps IPython active after a recoverable finalization rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-'))
    roots.push(root)
    const runtime = new SessionAwareNotebookRuntime({
      helperPath: fileURLToPath(new URL('../fixtures/notebook-helper.py', import.meta.url)),
      allowedMethods: { 'refine-meta': ['candidate.finalize'], rollout: [] },
      bridge: async () => ({ accepted: false, recoverable: true }),
    })
    runtimes.push(runtime)
    const result = await runtime.execute({
      sessionId: 'meta-recovery', cwd: root, role: 'refine-meta',
      code: "candidate.finalize(rationale='r', expectedOutcome='x', evidenceRefs=['e'])",
    })
    expect(result.concludesTurn).toBeUndefined()
    await expect(runtime.execute({
      sessionId: 'meta-recovery', cwd: root, role: 'refine-meta', code: '1 + 1',
    })).resolves.toMatchObject({ result: '2' })
  })

  it('does not silently rebind a session kernel to another role or cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-'))
    roots.push(root)
    const runtime = new SessionAwareNotebookRuntime({
      helperPath: fileURLToPath(new URL('../fixtures/notebook-helper.py', import.meta.url)),
    })
    runtimes.push(runtime)
    await runtime.execute({ sessionId: 'fixed', cwd: root, role: 'refine-meta', code: '1' })
    await expect(runtime.execute({ sessionId: 'fixed', cwd: root, role: 'target', code: '1' }))
      .rejects.toThrow(/different cwd or role/)
    await runtime.dispose()
    await expect(runtime.execute({ sessionId: 'new', cwd: root, role: 'target', code: '1' }))
      .rejects.toThrow(/disposed/)
  })

  const hasIpython = spawnSync('python3', ['-c', 'import IPython'], { stdio: 'ignore' }).status === 0
  it.skipIf(!hasIpython)('runs the packaged helper against a real IPython installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-ipython-'))
    roots.push(root)
    const runtime = new SessionAwareNotebookRuntime()
    runtimes.push(runtime)
    const result = await runtime.execute({ sessionId: 'real', cwd: root, role: 'rollout', code: '%precision 3\n1 / 3' })
    expect(result.result).toContain('0.333')
    const printed = await runtime.execute({ sessionId: 'real', cwd: root, role: 'rollout', code: "print('hello')" })
    expect(printed).toMatchObject({ stdout: 'hello\n' })
    expect(printed.result).toBeUndefined()
    const help = await runtime.execute({ sessionId: 'real', cwd: root, role: 'rollout', code: 'help(trajectory.query)' })
    expect(help.stdout).toContain('bundle, steps, context, and raw-event views')
    expect(help.result).toBeUndefined()
  })

  const sandboxDependencies = process.platform === 'darwin' || process.platform === 'linux'
    ? SandboxManager.checkDependencies().errors
    : ['unsupported platform']
  const canListenLoopback = spawnSync(process.execPath, ['-e', "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>n.close(()=>process.exit(0)));n.on('error',()=>process.exit(1))"]).status === 0
  it.skipIf(sandboxDependencies.length > 0 || !canListenLoopback)('sandboxes the entire meta kernel with scratch-only data access and a sanitized environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-sandbox-'))
    roots.push(root)
    const secret = join(root, 'control-plane-secret.txt')
    const hostSocket = join(root, 'control-plane.sock')
    await writeFile(secret, 'held-out-control-data')
    const server: Server = createServer()
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(hostSocket, resolvePromise)
    })
    const tcpServer: Server = createServer()
    await new Promise<void>((resolvePromise, reject) => {
      tcpServer.once('error', reject)
      tcpServer.listen(0, '127.0.0.1', resolvePromise)
    })
    const tcpAddress = tcpServer.address()
    if (tcpAddress === null || typeof tcpAddress === 'string') throw new Error('test TCP server has no port')
    const abstractSocket = `\0gear-control-${process.pid}-${Date.now()}`
    const abstractServer = process.platform === 'linux' ? createServer() : undefined
    if (abstractServer !== undefined) {
      await new Promise<void>((resolvePromise, reject) => {
        abstractServer.once('error', reject)
        abstractServer.listen(abstractSocket, resolvePromise)
      })
    }
    const previous = process.env.REFINE_NOTEBOOK_TEST_SECRET
    process.env.REFINE_NOTEBOOK_TEST_SECRET = 'must-not-cross'
    const runtime = new SessionAwareNotebookRuntime({
      helperPath: fileURLToPath(new URL('../fixtures/notebook-helper.py', import.meta.url)),
      sandbox: {
        roles: ['refine-meta'],
        mode: 'required',
        linuxIsolation: process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp',
        scratchRoot: join(root, 'scratch'),
      },
    })
    runtimes.push(runtime)
    try {
      await runtime.initialize()
      const cwd = await runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: "(__import__('os').getcwd(), __import__('os').environ.get('REFINE_NOTEBOOK_TEST_SECRET'))",
      })
      expect(cwd.result).toContain('/scratch/')
      expect(cwd.result).toContain('None')
      const write = await runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: "open('proposal.tmp', 'w').write('ok')",
      })
      expect(write.result).toBe('2')
      await expect(runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: `open(${JSON.stringify(secret)}).read()`,
      })).rejects.toThrow(/Operation not permitted|Permission denied|No such file or directory/iu)
      const childRead = await runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: `__import__('subprocess').run(['/bin/cat', ${JSON.stringify(secret)}], capture_output=True).returncode`,
      })
      expect(childRead.result).not.toBe('0')
      await expect(runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: `__import__('socket').create_connection(('127.0.0.1', ${tcpAddress.port}), timeout=0.1)`,
      })).rejects.toThrow(/Operation not permitted|Permission denied|Network is unreachable|Connection refused|timed out/iu)
      const hostSocketVisible = await runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: `__import__('os').path.exists(${JSON.stringify(hostSocket)})`,
      })
      expect(hostSocketVisible.result).toBe('False')
      await expect(runtime.execute({
        sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
        code: `__import__('socket').socket(__import__('socket').AF_UNIX).connect(${JSON.stringify(hostSocket)})`,
      })).rejects.toThrow(/Operation not permitted|Permission denied|No such file or directory/iu)
      if (abstractServer !== undefined) {
        await expect(runtime.execute({
          sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
          code: `__import__('socket').socket(__import__('socket').AF_UNIX).connect(${JSON.stringify(abstractSocket)})`,
        })).rejects.toThrow(/Operation not permitted|Permission denied|Connection refused|No such file or directory/iu)
      }
      try {
        const hostProcess = await runtime.execute({
          sessionId: 'meta-sandbox', cwd: root, role: 'refine-meta',
          code: `'must-not-cross' in __import__('subprocess').run(['/bin/ps', 'eww', '-p', '${process.pid}'], capture_output=True, text=True).stdout`,
        })
        expect(hostProcess.result).toBe('False')
      } catch (error) {
        expect(String(error)).toMatch(/Operation not permitted|Permission denied/iu)
      }
    } finally {
      if (abstractServer !== undefined) await new Promise<void>(resolvePromise => abstractServer.close(() => resolvePromise()))
      await new Promise<void>(resolvePromise => tcpServer.close(() => resolvePromise()))
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
      if (previous === undefined) delete process.env.REFINE_NOTEBOOK_TEST_SECRET
      else process.env.REFINE_NOTEBOOK_TEST_SECRET = previous
    }
  })
})
