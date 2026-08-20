import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionAwareNotebookRuntime } from '../../src/notebook/runtime.js'

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
      allowedMethods: { 'refine-meta': ['harness.current', 'submit_refinement_proposal'], rollout: [] },
      bridge: async (method) => { calls.push(method); return { ok: true } },
    })
    runtimes.push(runtime)
    const result = await runtime.execute({
      sessionId: 'meta', cwd: root, role: 'refine-meta',
      code: "harness.current(); submit_refinement_proposal(roundId='r1', mutation=None)",
    })
    expect(calls).toEqual(['harness.current', 'submit_refinement_proposal'])
    expect(result.concludesTurn).toBe(true)
    await expect(runtime.execute({
      sessionId: 'rollout', cwd: root, role: 'rollout', code: 'harness.current()',
    })).rejects.toThrow(/PermissionError/)
  })

  const hasIpython = spawnSync('python3', ['-c', 'import IPython'], { stdio: 'ignore' }).status === 0
  it.skipIf(!hasIpython)('runs the packaged helper against a real IPython installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refine-notebook-ipython-'))
    roots.push(root)
    const runtime = new SessionAwareNotebookRuntime()
    runtimes.push(runtime)
    const result = await runtime.execute({ sessionId: 'real', cwd: root, role: 'rollout', code: '%precision 3\n1 / 3' })
    expect(result.result).toContain('0.333')
  })
})
