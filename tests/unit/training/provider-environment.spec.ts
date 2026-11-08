import { describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { providerDiagnostics, providerEnvironment } from '../../../src/adapters/hitch/environment.js'
import { assertEvaluationEnvironment, observeEvaluationEnvironment, type ObservationCall } from '../../../src/adapters/hitch/observation.js'

function fixture() {
  const controller = { schema_version: '2' as const, package_version: '0.2.9', node_version: 'v22.0.0', runtime_id: digestJson('runtime'),
    source: { kind: 'git-checkout' as const, commit: 'a'.repeat(40), dirty: true } }
  const expected = { nonce: 'b'.repeat(32), provider: 'local-docker', workerId: 'local', collisionDomainId: 'domain', controller }
  const environment = { schema_version: '2', host_platform: 'darwin-arm64',
    harbor: { status: 'available', version: '0.21.0', executable_digest: digestJson('harbor') },
    docker: { status: 'available', version: '28.1.0', executable_digest: digestJson('docker'), engine_id: 'engine-id', os: 'linux', architecture: 'aarch64' },
    buildx: { status: 'unavailable', version: null as string | null }, sandbox: { status: 'unverified' } }
  const response = { schema_version: '2', nonce: expected.nonce, provider: expected.provider, worker_id: expected.workerId,
    collision_domain_id: expected.collisionDomainId, generation: null as number | null, daemon_instance_id: 'c'.repeat(32),
    daemon_runtime: { schema_version: '2', startup: structuredClone(controller), current: structuredClone(controller), unchanged: true },
    environment, environment_digest: digestJson(environment) }
  return { expected, response }
}

describe('fresh provider environment admission', () => {
  it('returns only stable observed environment, with sandbox verification still pending', () => {
    const { expected, response } = fixture()
    const observed = providerEnvironment(response, expected)
    expect(observed).toEqual(response.environment)
    response.daemon_instance_id = 'd'.repeat(32)
    expect(providerEnvironment(response, expected)).toEqual(observed)
    response.environment.buildx = { status: 'available', version: '0.23.0' }
    response.environment_digest = digestJson(response.environment)
    expect(providerEnvironment(response, expected)).toEqual(response.environment)
  })
  it('rejects stale nonce, another worker/collision domain and remote generations', () => {
    for (const change of [{ nonce: 'd'.repeat(32) }, { worker_id: 'another' }, { collision_domain_id: 'another' }, { generation: 2 }]) {
      const { expected, response } = fixture()
      expect(() => providerEnvironment({ ...response, ...change }, expected)).toThrow(expect.objectContaining({ code: 'provider-observation-mismatch' }))
    }
  })
  it('rejects rebuilt daemon payload even when the daemon falsely says unchanged', () => {
    const { expected, response } = fixture()
    response.daemon_runtime.startup.runtime_id = digestJson('old-loaded-code')
    expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'daemon-runtime-drift' }))
    response.daemon_runtime.current = structuredClone(response.daemon_runtime.startup)
    expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'daemon-runtime-drift' }))
    response.daemon_runtime.startup = structuredClone(expected.controller)
    response.daemon_runtime.current = structuredClone(expected.controller)
    response.daemon_runtime.unchanged = false
    expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'daemon-runtime-drift' }))
  })
  it('rejects unavailable tools or another Docker OS despite registered capabilities', () => {
    for (const mutate of [
      (r: ReturnType<typeof fixture>['response']) => { r.environment.harbor.status = 'unavailable' },
      (r: ReturnType<typeof fixture>['response']) => { r.environment.docker.status = 'unavailable' },
      (r: ReturnType<typeof fixture>['response']) => { r.environment.docker.os = 'windows' },
      (r: ReturnType<typeof fixture>['response']) => { r.environment.docker.engine_id = '' },
    ]) {
      const { expected, response } = fixture()
      mutate(response); response.environment_digest = digestJson(response.environment)
      expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'provider-environment-unavailable' }))
    }
  })
  it('rejects changed environment bytes and an unsupported sandbox certification claim', () => {
    const { expected, response } = fixture()
    response.environment.docker.engine_id = 'replacement-engine'
    expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'provider-environment-drift' }))
    response.environment.sandbox.status = 'verified'
    response.environment_digest = digestJson(response.environment)
    expect(() => providerEnvironment(response, expected)).toThrow(expect.objectContaining({ code: 'invalid-provider-environment' }))
  })
  it('identifies failed environment checks without publishing raw diagnostics or malformed values', () => {
    const { expected, response } = fixture()
    const unavailable = {
      ...response.environment,
      harbor: { status: 'unavailable', version: null, executable_digest: null, error: 'private-token' },
      docker: { ...response.environment.docker, status: 'private-status', os: 'private-os' },
    }
    let failure: Error | undefined
    try {
      providerEnvironment({ ...response, environment: unavailable, environment_digest: digestJson(unavailable) }, expected)
    } catch (error) { failure = error as Error }
    expect(failure).toMatchObject({ code: 'provider-environment-unavailable' })
    expect(failure!.message).toContain('failed checks: harbor.status, harbor.version, harbor.executable_digest, docker.status, docker.os')
    expect(failure!.message).toContain('harbor=unavailable, docker=invalid')
    expect(failure!.message).not.toContain('private-')
    expect(failure!.message.length).toBeLessThan(500)
  })
  it('pins remote generation and accepts an identical payload from a source-less worker package', () => {
    const { expected, response } = fixture()
    const worker = { ...expected.controller, node_version: 'v24.0.0', source: { kind: 'unavailable', commit: null, dirty: null } }
    const remote = { ...response, generation: 3, worker_runtime: { schema_version: '2', startup: structuredClone(worker), current: structuredClone(worker), unchanged: true } }
    expect(providerEnvironment(remote, { ...expected, generation: 3 })).toEqual(response.environment)
    expect(() => providerEnvironment(remote, { ...expected, generation: 2 })).toThrow(expect.objectContaining({ code: 'provider-observation-mismatch' }))
    remote.worker_runtime.startup.runtime_id = digestJson('old-worker-runtime')
    expect(() => providerEnvironment(remote, { ...expected, generation: 3 })).toThrow(expect.objectContaining({ code: 'worker-runtime-drift' }))
    remote.worker_runtime.current = structuredClone(remote.worker_runtime.startup)
    expect(() => providerEnvironment(remote, { ...expected, generation: 3 })).toThrow(expect.objectContaining({ code: 'worker-runtime-drift' }))
  })
})

function probe(overrides: Record<string, unknown> = {}) {
  return { probe: 'docker_info', attempt: 1, stage: 'command', outcome: 'nonzero_exit', elapsed_ms: 12, exit_code: 1, signal: null, ...overrides }
}
function diagnostics(probes = [probe()]) { return { schema_version: '1', probes } }
function residentCall(response: ReturnType<typeof fixture>['response'], extra: Record<string, unknown> = {}) {
  return vi.fn<ObservationCall>(async (args, signal) => {
    signal.throwIfAborted()
    if (args[0] === 'daemon') return { status: 'running', instance_id: response.daemon_instance_id }
    if (args[0] === 'training') return response.daemon_runtime.current
    if (args[1] === 'list') return { workers: [{ provider: response.provider, worker_id: response.worker_id, collision_domain_id: response.collision_domain_id, health: 'healthy' }] }
    return structuredClone({ ...response, nonce: args[args.indexOf('--nonce') + 1], ...extra })
  })
}

describe('bounded provider probe diagnostics', () => {
  it('rebuilds safe terminal records and preserves every supported stage and outcome', () => {
    const cases = [
      probe({ stage: 'complete', outcome: 'ok', exit_code: 0 }),
      probe({ stage: 'resolve', outcome: 'not_found', exit_code: null }),
      ...['resolve', 'fingerprint', 'identity'].map(stage => probe({ stage, outcome: 'io_error', exit_code: null })),
      ...['spawn_error', 'nonzero_exit', 'timed_out', 'output_limit'].map(outcome => probe({ outcome })),
      probe({ outcome: 'signal_exit', exit_code: null, signal: 'SIGKILL' }),
      ...['invalid_encoding', 'invalid_json'].map(outcome => probe({ stage: 'parse', outcome, exit_code: 0 })),
      probe({ stage: 'validate', outcome: 'invalid_fields', exit_code: 0 }),
      probe({ stage: 'identity', outcome: 'executable_changed', exit_code: 0 }),
    ]
    for (const record of cases) {
      const value = diagnostics([record]), safe = providerDiagnostics(value)
      expect(safe).toEqual(value)
      expect(safe).not.toBe(value)
      expect(safe.probes[0]).not.toBe(record)
    }
    const maximum = diagnostics([
      probe({ probe: 'harbor_version', stage: 'complete', outcome: 'ok', exit_code: 0 }),
      probe({ elapsed_ms: 30_000, exit_code: -2_147_483_648 }),
      probe({ attempt: 2, elapsed_ms: 0, exit_code: 4_294_967_295 }),
      probe({ probe: 'buildx_version', outcome: 'signal_exit', exit_code: null, signal: 'other' }),
    ])
    expect(providerDiagnostics(maximum)).toEqual(maximum)
  })

  it('publishes only validated structured fields in an unavailable error', () => {
    const { expected, response } = fixture(), detail = diagnostics([
      probe({ outcome: 'timed_out', elapsed_ms: 10_000, exit_code: null, signal: 'SIGTERM' }),
      probe({ attempt: 2, stage: 'parse', outcome: 'invalid_json', exit_code: 0 }),
    ])
    response.environment.docker.status = 'unavailable'
    response.environment_digest = digestJson(response.environment)
    let failure: Error | undefined
    try { providerEnvironment({ ...response, diagnostics: detail }, expected) } catch (error) { failure = error as Error }
    expect(failure).toMatchObject({ code: 'provider-environment-unavailable' })
    expect(JSON.parse(failure!.message.split('; diagnostics=')[1]!)).toEqual(detail)
    expect(failure!.message).toContain('failed checks: docker.status')
  })

  const invalidRecords: Array<[string, Record<string, unknown>]> = [
    ['extra raw text', { stderr: 'private-token' }],
    ['unknown probe', { probe: 'private-token' }],
    ['array probe', { probe: ['docker_info'] }],
    ['non-Docker second attempt', { probe: 'harbor_version', attempt: 2 }],
    ['second attempt without first', { attempt: 2 }],
    ['third attempt', { attempt: 3 }],
    ['string attempt', { attempt: '1' }],
    ['unknown stage', { stage: 'private-token' }],
    ['array stage', { stage: ['command'] }],
    ['unknown outcome', { outcome: 'private-token' }],
    ['array outcome', { outcome: ['nonzero_exit'] }],
    ['wrong stage for outcome', { stage: 'parse' }],
    ['negative elapsed time', { elapsed_ms: -1 }],
    ['fractional elapsed time', { elapsed_ms: 1.5 }],
    ['excess elapsed time', { elapsed_ms: 30_001 }],
    ['string elapsed time', { elapsed_ms: '1' }],
    ['fractional exit code', { exit_code: 1.5 }],
    ['exit code underflow', { exit_code: -2_147_483_649 }],
    ['exit code overflow', { exit_code: 4_294_967_296 }],
    ['unknown signal', { signal: 'private-token' }],
    ['array signal', { signal: ['SIGTERM'] }],
    ['zero nonzero exit', { exit_code: 0 }],
    ['missing nonzero exit', { exit_code: null }],
    ['nonzero exit and signal', { signal: 'SIGTERM' }],
    ['signal exit without signal', { outcome: 'signal_exit', exit_code: null }],
    ['signal exit and exit code', { outcome: 'signal_exit', signal: 'SIGTERM' }],
    ['ok with missing exit code', { stage: 'complete', outcome: 'ok', exit_code: null }],
    ['ok with failed exit code', { stage: 'complete', outcome: 'ok', exit_code: 1 }],
    ['ok with signal', { stage: 'complete', outcome: 'ok', exit_code: 0, signal: 'SIGKILL' }],
  ]
  it.each(invalidRecords)('rejects %s without exposing provider values', (_name, change) => {
    const { expected, response } = fixture()
    try {
      providerEnvironment({ ...response, diagnostics: diagnostics([probe(change)]) }, expected)
      expect.fail('invalid diagnostics accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-provider-environment' })
      expect((error as Error).message).not.toContain('private-token')
    }
  })

  it.each([
    null,
    [],
    { schema_version: 'private-token', probes: [probe()] },
    { ...diagnostics(), stderr: 'private-token' },
    diagnostics([]),
    diagnostics(new Array(1)),
    diagnostics([probe(), probe()]),
    diagnostics([probe({ attempt: 2 }), probe()]),
    diagnostics(Array.from({ length: 5 }, () => probe())),
    diagnostics([probe({ exit_code: undefined })]),
  ])('rejects malformed or excessive diagnostics %#', value => {
    const { expected, response } = fixture()
    expect(() => providerEnvironment({ ...response, diagnostics: value }, expected)).toThrow(expect.objectContaining({ code: 'invalid-provider-environment' }))
  })

  it('checks request binding, resident runtime and environment digest before diagnostics', () => {
    const { expected, response } = fixture(), diagnostics = { stderr: 'private-token' }
    for (const [change, code] of [
      [{ nonce: 'wrong' }, 'provider-observation-mismatch'],
      [{ daemon_runtime: { ...response.daemon_runtime, unchanged: false } }, 'daemon-runtime-drift'],
      [{ environment_digest: digestJson('wrong') }, 'provider-environment-drift'],
    ] as const) {
      expect(() => providerEnvironment({ ...response, ...change, diagnostics }, expected)).toThrow(expect.objectContaining({ code }))
    }
  })

  it('keeps diagnostic churn outside frozen identity while still rejecting actual engine drift', async () => {
    const { response } = fixture(), signal = new AbortController().signal
    const frozen = await observeEvaluationEnvironment(residentCall(response), signal)
    const detail = diagnostics([probe({ stage: 'complete', outcome: 'ok', exit_code: 0 })])
    const changedDiagnostics = residentCall(response, { diagnostics: detail })
    await expect(assertEvaluationEnvironment(changedDiagnostics, signal, frozen)).resolves.toBeUndefined()
    expect(await observeEvaluationEnvironment(changedDiagnostics, signal)).toEqual(frozen)
    response.environment.docker.engine_id = 'replacement-engine'
    response.environment_digest = digestJson(response.environment)
    await expect(assertEvaluationEnvironment(residentCall(response, { diagnostics: detail }), signal, frozen)).rejects.toMatchObject({ code: 'hitch-environment-drift' })
  })

  it('does not retry an unavailable provider or replace cancellation with an environment failure', async () => {
    const { response } = fixture()
    response.environment.docker.status = 'unavailable'
    response.environment_digest = digestJson(response.environment)
    const call = residentCall(response, { diagnostics: diagnostics() }), abort = new AbortController()
    await expect(observeEvaluationEnvironment(call, abort.signal)).rejects.toMatchObject({ code: 'provider-environment-unavailable' })
    expect(call.mock.calls.filter(([args]) => args[1] === 'observe')).toHaveLength(1)
    const reason = new Error('cancel observation')
    abort.abort(reason)
    await expect(observeEvaluationEnvironment(call, abort.signal)).rejects.toBe(reason)
    expect(call.mock.calls.filter(([args]) => args[1] === 'observe')).toHaveLength(1)
  })
})
