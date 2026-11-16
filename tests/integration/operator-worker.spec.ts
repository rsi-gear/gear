import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { freezeAlgorithmSource, type AlgorithmResource } from '../../src/adapters/python/source.js'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { AlgorithmConfig } from '../../src/domain/run.js'
import type { SearchView } from '../../src/domain/algorithm-wire-v2.js'

const roots: string[] = []
const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reconstructs the SDK component tree and exchanges explicit v2 calls and results in the frozen worker', async () => {
  const description = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        `
import json
from gear.project import Project
from gear.ops import Meta
from operator_tree import CriticAlgorithm
algorithm = CriticAlgorithm(Meta('Review the authorized candidate', {'type': 'object'}, max_tokens=512))
description = Project._describe_algorithm(algorithm)
algorithm.set_params(critic__prompt='LOCAL MUTATION MUST NOT CHANGE THE FROZEN DESCRIPTION')
print(json.dumps(description))
`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: [resolve('python'), resolve('tests/fixtures')].join(':') },
      },
    ),
  ) as {
    algorithm: AlgorithmConfig
    sources: Array<{ path: string; source: string }>
  }
  const root = await mkdtemp(join(tmpdir(), 'gear-operator-worker-'))
  roots.push(root)
  const source = join(root, 'source'),
    scratch = join(root, 'scratch')
  await mkdir(scratch)
  const identity = await freezeAlgorithmSource(source, description.sources)
  const worker = new PythonAlgorithmWorker({
    python,
    sourceRoot: source,
    scratch,
    implementationIdentity: identity,
    protocolVersion: 2,
    ...(process.env.GEAR_TEST_LINUX_ISOLATION
      ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' }
      : {}),
  })
  const anchor = { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') }
  const view: SearchView = {
    run_id: 'run',
    step_id: 0,
    seed: 'test',
    tasks: [{ id: 'task', family: 'test', estimated_cost: 1, input: null }],
    candidates: [anchor],
    anchor,
    results: [],
    budget: {},
    objective: null,
    history: null,
    stream: null,
    assets: [],
    capabilities: ['meta'],
  }
  const signal = new AbortController().signal
  try {
    await worker.start(signal)
    const first = await worker.stepV2(view, { version: 2, data: {} }, description.algorithm, signal)
    expect(first.calls).toHaveLength(1)
    const call = first.calls[0]!
    expect(call.effect).toMatchObject({
      kind: 'meta',
      input: { prompt: 'Review the authorized candidate', max_tokens: 512 },
    })
    const reference = { key: call.key, request_digest: canonicalDigest(call) }
    expect(first.state.data.pending).toEqual(reference)
    const second = await worker.stepV2(
      {
        ...view,
        step_id: 1,
        results: [
          {
            ref: reference,
            status: 'succeeded',
            value: { status: 'allow' },
            error: null,
            artifacts: [],
            usage: null,
          },
        ],
      },
      first.state,
      description.algorithm,
      signal,
    )
    expect(second.calls).toEqual([])
    expect(second.state.version).toBe(2)
    expect(second.terminal).toEqual({ kind: 'stop', candidate: null, outcome: { status: 'allow' } })
  } finally {
    await worker.dispose()
  }
}, 30_000)

it('freezes declared resource bytes and never reopens the original author path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-operator-resource-'))
  roots.push(root)
  const resourcePath = join(root, 'prompt.txt')
  await writeFile(resourcePath, 'Frozen 中文 prompt')
  const description = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        `
import json, sys
from gear.project import Project
from operator_tree import ResourceAlgorithm
print(json.dumps(Project._describe_algorithm(ResourceAlgorithm(sys.argv[1]))))
`,
        resourcePath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: [resolve('python'), resolve('tests/fixtures')].join(':') },
      },
    ),
  ) as {
    algorithm: AlgorithmConfig
    sources: Array<{ path: string; source: string }>
    resources: AlgorithmResource[]
  }
  await writeFile(resourcePath, 'CHANGED AFTER SDK CAPTURE')
  const source = join(root, 'source'),
    scratch = join(root, 'scratch')
  await mkdir(scratch)
  const identity = await freezeAlgorithmSource(source, description.sources, [], description.resources)
  const worker = new PythonAlgorithmWorker({
    python,
    sourceRoot: source,
    scratch,
    implementationIdentity: identity,
    protocolVersion: 2,
    protectedPaths: [resourcePath],
    ...(process.env.GEAR_TEST_LINUX_ISOLATION
      ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' }
      : {}),
  })
  const anchor = { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') }
  const view: SearchView = {
    run_id: 'run',
    step_id: 0,
    seed: 'test',
    tasks: [],
    candidates: [anchor],
    anchor,
    results: [],
    budget: {},
    objective: null,
    history: null,
    stream: null,
    assets: [],
    capabilities: [],
  }
  try {
    await worker.start(new AbortController().signal)
    const decision = await worker.stepV2(
      view,
      { version: 1, data: {} },
      description.algorithm,
      new AbortController().signal,
    )
    expect(decision.terminal?.outcome).toBe('Frozen 中文 prompt')
  } finally {
    await worker.dispose()
  }
  const changed = [
    { ...description.resources[0]!, content_base64: Buffer.from('tampered').toString('base64') },
  ]
  await expect(
    freezeAlgorithmSource(join(root, 'invalid'), description.sources, [], changed),
  ).rejects.toMatchObject({ code: 'algorithm-resource-invalid' })
}, 30_000)
