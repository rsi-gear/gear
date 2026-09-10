import { describe, expect, it } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { providerEnvironment } from '../../../src/training/provider-environment.js'

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
