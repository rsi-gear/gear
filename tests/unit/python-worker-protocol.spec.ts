import { expect, it, vi } from 'vitest'
import { MAX_ALGORITHM_MESSAGE_BYTES, PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import type { Json, WorkerRequest, WorkerResponse } from '../../src/domain/algorithm-wire.js'

const signal = new AbortController().signal
const workerOptions = {
  python: 'unused',
  sourceRoot: 'unused',
  scratch: 'unused',
  implementationIdentity: 'unused',
}
type WorkerInternals = {
  child: { stdin: { write(bytes: Buffer): boolean } }
  request(
    method: WorkerRequest['method'],
    run: string,
    step: number,
    payload: Json,
    signal: AbortSignal,
  ): Promise<Json>
  onData(chunk: Buffer): void
  responseChunks: Buffer[]
  responseBytes: number
  failure?: Error & { code?: string }
}

function workerFixture(onWrite?: (bytes: Buffer, internals: WorkerInternals) => void) {
  const worker = new PythonAlgorithmWorker(workerOptions)
  const internals = worker as unknown as WorkerInternals
  const write = vi.fn((bytes: Buffer) => {
    onWrite?.(bytes, internals)
    return true
  })
  internals.child = { stdin: { write } }
  return { worker, internals, write }
}

function response(request: WorkerRequest, result: Json): WorkerResponse {
  return {
    protocol_version: 1,
    request_id: request.request_id,
    run_id: request.run_id,
    step_id: request.step_id,
    input_digest: request.input_digest,
    result,
    error: null,
  }
}

function sizedPayload(extraBytes: number): Json {
  const payload = {
    view: { evidence: ['private-evidence-测🙂\n'], completed: [{ data: 'private-completed' }] },
    state: { private_state: 'private-state', padding: '' },
    algorithm: { name: 'private-algorithm' },
  }
  const envelope: WorkerRequest = {
    protocol_version: 1,
    request_id: '0'.repeat(36),
    run_id: 'run',
    step_id: 0,
    input_digest: `sha256:${'0'.repeat(64)}`,
    method: 'step',
    payload,
  }
  payload.state.padding = 'x'.repeat(
    MAX_ALGORITHM_MESSAGE_BYTES + extraBytes - Buffer.byteLength(`${JSON.stringify(envelope)}\n`),
  )
  return payload
}

it('writes an exactly-at-limit UTF-8 request including its envelope and newline', async () => {
  const { worker, internals, write } = workerFixture((bytes, worker) => {
    const request = JSON.parse(bytes.toString('utf8')) as WorkerRequest
    expect(bytes.length).toBe(MAX_ALGORITHM_MESSAGE_BYTES)
    expect(bytes.at(-1)).toBe(10)
    expect(bytes.toString('utf8')).toContain('private-evidence-测🙂')
    worker.onData(Buffer.from(`${JSON.stringify(response(request, 'accepted'))}\n`))
  })
  try {
    await expect(internals.request('step', 'run', 0, sizedPayload(0), signal)).resolves.toBe('accepted')
    expect(write).toHaveBeenCalledTimes(1)
  } finally {
    await worker.dispose()
  }
})

it('rejects a one-byte-oversize request before stdin write with numeric-only field diagnostics', async () => {
  const { worker, internals, write } = workerFixture()
  const payload = sizedPayload(1) as {
    view: { evidence: Json; completed: Json }
    state: Json
    algorithm: Json
  }
  const bytes = (value: Json) => Buffer.byteLength(JSON.stringify(value))
  try {
    const error = await internals
      .request('step', 'run', 0, payload, signal)
      .catch((error) => error as Error & { code: string })
    expect(error).toMatchObject({ code: 'algorithm-message-too-large' })
    const message = (error as Error).message
    expect(message).toContain(
      `Algorithm request is ${MAX_ALGORITHM_MESSAGE_BYTES + 1} bytes; protocol limit is ${MAX_ALGORITHM_MESSAGE_BYTES} bytes`,
    )
    expect(message).toContain(
      `view=${bytes(payload.view)}, evidence=${bytes(payload.view.evidence)}, completed=${bytes(payload.view.completed)}, state=${bytes(payload.state)}, algorithm=${bytes(payload.algorithm)}`,
    )
    expect(message).toContain('evidence/completed are included in view')
    expect(message).not.toContain('private-')
    expect(write).not.toHaveBeenCalled()
  } finally {
    await worker.dispose()
  }
})

it.each([0, 1])(
  'bounds fragmented UTF-8 responses including their newline (excess bytes=%i)',
  async (excess) => {
    let sent!: WorkerRequest
    const { worker, internals } = workerFixture((bytes) => {
      sent = JSON.parse(bytes.toString('utf8'))
    })
    try {
      const pending = internals.request('handshake', 'run', 0, {}, signal)
      const prefix = '测🙂\n'
      const base = Buffer.byteLength(`${JSON.stringify(response(sent, prefix))}\n`)
      const result = prefix + 'x'.repeat(MAX_ALGORITHM_MESSAGE_BYTES + excess - base)
      const line = Buffer.from(`${JSON.stringify(response(sent, result))}\n`)
      expect(line.length).toBe(MAX_ALGORITHM_MESSAGE_BYTES + excess)
      const expectation = excess
        ? expect(pending).rejects.toMatchObject({ code: 'algorithm-message-too-large' })
        : expect(pending).resolves.toBe(result)
      const concat = vi.spyOn(Buffer, 'concat')
      try {
        // Split inside a Unicode codepoint, then feed realistic pipe-sized chunks.
        const split = line.indexOf(Buffer.from('测')) + 1
        internals.onData(line.subarray(0, split))
        for (let offset = split; offset < line.length; offset += 64 * 1024)
          internals.onData(line.subarray(offset, offset + 64 * 1024))
        await expectation
        expect(concat).toHaveBeenCalledTimes(excess ? 0 : 1)
        expect(internals.responseChunks).toEqual([])
        expect(internals.responseBytes).toBe(0)
        if (excess) {
          expect(internals.failure?.message).toContain(`received ${MAX_ALGORITHM_MESSAGE_BYTES + 1} bytes`)
          expect(internals.failure?.message).not.toContain(prefix)
        }
      } finally {
        concat.mockRestore()
      }
    } finally {
      await worker.dispose()
    }
  },
)

it('bounds each frame independently when one chunk exceeds the limit and contains a duplicate', async () => {
  let sent!: WorkerRequest
  const { worker, internals } = workerFixture((bytes) => {
    sent = JSON.parse(bytes.toString('utf8'))
  })
  try {
    const pending = internals.request('handshake', 'run', 0, {}, signal)
    const base = Buffer.byteLength(`${JSON.stringify(response(sent, ''))}\n`)
    const result = 'x'.repeat(MAX_ALGORITHM_MESSAGE_BYTES - base)
    const line = Buffer.from(`${JSON.stringify(response(sent, result))}\n`)
    const duplicate = Buffer.from(`${JSON.stringify(response(sent, 'duplicate'))}\n`)
    expect(line.length).toBe(MAX_ALGORITHM_MESSAGE_BYTES)
    internals.onData(Buffer.concat([line, duplicate]))
    await expect(pending).resolves.toBe(result)
    expect(internals.failure?.code).toBe('algorithm-stale-response')
    expect(internals.responseChunks).toEqual([])
    expect(internals.responseBytes).toBe(0)
  } finally {
    await worker.dispose()
  }
})

it('releases unfinished response chunks on disposal', async () => {
  const { worker, internals } = workerFixture()
  const pending = expect(internals.request('handshake', 'run', 0, {}, signal)).rejects.toMatchObject({
    code: 'algorithm-worker-disposed',
  })
  internals.onData(Buffer.from('{"unfinished":'))
  expect(internals.responseBytes).toBeGreaterThan(0)
  await worker.dispose()
  await pending
  expect(internals.responseChunks).toEqual([])
  expect(internals.responseBytes).toBe(0)
})

it('rejects invalid UTF-8 response bytes without retaining partial data', async () => {
  const { worker, internals } = workerFixture()
  const rejected = expect(internals.request('handshake', 'run', 0, {}, signal)).rejects.toBeInstanceOf(
    TypeError,
  )
  try {
    internals.onData(Buffer.from([0x22, 0xc3]))
    internals.onData(Buffer.from([0x28, 0x22, 0x0a]))
    await rejected
    expect(internals.responseChunks).toEqual([])
    expect(internals.responseBytes).toBe(0)
  } finally {
    await worker.dispose()
  }
})

it.each(['request_id', 'run_id', 'step_id', 'input_digest'] as const)(
  'rejects response ownership changes to %s',
  async (key) => {
    let sent!: WorkerRequest
    const { worker, internals } = workerFixture((bytes) => {
      sent = JSON.parse(bytes.toString('utf8'))
    })
    const rejected = expect(internals.request('handshake', 'run', 0, {}, signal)).rejects.toMatchObject({
      code: 'algorithm-stale-response',
    })
    try {
      const stale = response(sent, 'untrusted')
      if (key === 'step_id') stale.step_id++
      else stale[key] += '-stale'
      internals.onData(Buffer.from(`${JSON.stringify(stale)}\n`))
      await rejected
      expect(internals.responseChunks).toEqual([])
      expect(internals.responseBytes).toBe(0)
    } finally {
      await worker.dispose()
    }
  },
)
