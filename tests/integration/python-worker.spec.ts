import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { MAX_ALGORITHM_MESSAGE_BYTES, PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { algorithmCapacityFixture } from '../helpers/algorithm-capacity.js'
import type { Decision } from '../../src/domain/algorithm-wire.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('executes frozen Python decisions with OS filesystem, environment and network isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-python-sandbox-')); roots.push(root)
  const source = join(root, 'source'), scratch = join(root, 'scratch'), secret = join(root, 'held-out.json')
  await mkdir(scratch); await writeFile(secret, 'PRIVATE_HELD_OUT')
  const socketPath = join(root, 'control.sock'), server = createServer()
  server.listen(socketPath)
  await once(server, 'listening')
  const plugin = join(root, 'isolation.py')
  await writeFile(plugin, `from gear.algorithms import Decision, Operation
import os, socket
class Probe:
 def step(self, view, state):
  assert 'GEAR_PRIVATE_TEST' not in os.environ
  try:
   open(${JSON.stringify(secret)}).read()
   raise AssertionError('private file readable')
  except (PermissionError, FileNotFoundError): pass
  try:
   with socket.socket(socket.AF_UNIX) as control:
    control.connect(${JSON.stringify(socketPath)})
    raise AssertionError('host control socket accessible')
  except OSError: pass
  try:
   socket.create_connection(('1.1.1.1', 443), timeout=0.2)
   raise AssertionError('network accessible')
  except OSError: pass
  return Decision(state, (Operation('stop'),), 'sandbox verified')
`)
  const identity = await freezeAlgorithmSource(source, [{ path: 'isolation.py', source: plugin }])
  const worker = new PythonAlgorithmWorker({ python: process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', sourceRoot: source, scratch, implementationIdentity: identity,
    ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
  process.env.GEAR_PRIVATE_TEST = 'not-for-worker'
  try {
    await worker.start(new AbortController().signal)
    const decision = await worker.step({ run_id: 'test', step_id: 0, seed: 'test', tasks: [{ id: 'seed', family: 'a', estimated_cost: 1 }],
      candidates: [{ id: 'anchor', digest: canonicalDigest('anchor'), parent_id: null }], evidence: [], completed: [],
      budget: { evaluations_remaining: 5, candidates_remaining: 1, rounds: 1, repetitions: 1 }, anchor_id: 'anchor' },
    { version: 1, data: {} }, { name: 'isolation:Probe', options: {} }, new AbortController().signal)
    expect(decision.reason).toBe('sandbox verified')
  } finally { delete process.env.GEAR_PRIVATE_TEST; await worker.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 30_000)


it.each([600, 1300, 1800] as const)(
  'round-trips %i complete synthetic records and the GEPA result through the frozen production worker',
  async (records) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-python-capacity-')); roots.push(root)
    const source = join(root, 'source'), scratch = join(root, 'scratch')
    await mkdir(scratch)
    const identity = await freezeAlgorithmSource(source, [
      { path: 'capacity.py', source: resolve('tests/fixtures/algorithm-capacity.py') },
    ])
    const worker = new PythonAlgorithmWorker({
      python: process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', sourceRoot: source, scratch,
      implementationIdentity: identity,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}),
    })
    const { view, state, candidateIds, scores } = algorithmCapacityFixture(records)
    const projectionDigest = canonicalDigest({ view, state })
    try {
      await worker.start(new AbortController().signal)
      const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child
      const writes = vi.spyOn(child.stdin, 'write')
      let responseBytes = 0
      child.stdout.on('data', (chunk: Buffer) => { responseBytes += chunk.length })
      const started = performance.now()
      // Exercise the unchanged production 30s decision timeout, including large response parsing.
      const decision = await worker.step(view, state, { name: 'capacity:CapacityProbe', options: {} }, new AbortController().signal)
      const elapsedMs = Math.round(performance.now() - started)
      const requestBytes = (writes.mock.calls[0]![0] as Buffer).length
      expect(writes).toHaveBeenCalledTimes(1)
      writes.mockRestore()
      expect(requestBytes).toBeGreaterThan(4 * 1024 * 1024)
      expect(responseBytes).toBeGreaterThan(4 * 1024 * 1024)
      // Keep at least 40% transport headroom for this explicitly bounded fixture, not all JSON state.
      expect(Math.max(requestBytes, responseBytes)).toBeLessThan(MAX_ALGORITHM_MESSAGE_BYTES * 0.6)
      expect(decision.state.data.projection_digest).toBe(projectionDigest)
      expect(typeof decision.state.data.projection_json).toBe('string')
      const projection = JSON.parse(decision.state.data.projection_json as string)
      expect(canonicalDigest(projection)).toBe(projectionDigest)
      expect(projection).toEqual({ view, state })
      const ranking = decision.state.data.ranking as { candidate_ids: string[]; scores: Array<[string, number]>; incomplete: string[]; disqualified: string[] }
      expect(ranking.candidate_ids).toEqual(candidateIds)
      expect(ranking.incomplete).toEqual([])
      expect(ranking.disqualified).toEqual([])
      ranking.scores.forEach(([candidate, score], index) => {
        expect(candidate).toBe(scores[index]![0])
        expect(score).toBeCloseTo(scores[index]![1], 12)
      })
      const gepa = decision.state.data.gepa_decision as unknown as Decision
      expect(gepa.operations).toEqual(decision.operations)
      expect(gepa.operations).toMatchObject([{ kind: 'nominate', candidate_id: candidateIds[0] }])
      expect(gepa.state.data).toEqual({ ...state.data, phase: 'done' })
      console.info(JSON.stringify({ records, requestBytes, responseBytes, limitBytes: MAX_ALGORITHM_MESSAGE_BYTES, elapsedMs }))
    } finally { await worker.dispose() }
  }, 60_000,
)

it('rejects an existing frozen 4 MiB worker without modifying its source or recorded identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-python-old-capacity-')); roots.push(root)
  const source = join(root, 'source'), scratch = join(root, 'scratch')
  await mkdir(scratch)
  await freezeAlgorithmSource(source)
  const protocol = join(source, 'gear/refine/protocol.py')
  const oldSource = (await readFile(protocol, 'utf8')).replace('64 * 1024 * 1024', '4 * 1024 * 1024')
  await chmod(protocol, 0o600); await writeFile(protocol, oldSource); await chmod(protocol, 0o400)
  const identity = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-I', '-B', '-c',
    `import sys;from pathlib import Path;sys.path.insert(0,${JSON.stringify(source)});from gear.refine.identity import source_identity;print(source_identity(Path(${JSON.stringify(source)})))`,
  ], { encoding: 'utf8' }).trim()
  const worker = new PythonAlgorithmWorker({
    python: process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', sourceRoot: source, scratch,
    implementationIdentity: identity,
    ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}),
  })
  try {
    await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'algorithm-handshake-mismatch',
      message: expect.stringContaining('worker max_message_bytes=4194304; runtime max_message_bytes=67108864'),
    })
    expect(await readFile(protocol, 'utf8')).toBe(oldSource)
    expect(worker.options.implementationIdentity).toBe(identity)
  } finally { await worker.dispose() }
}, 30_000)
