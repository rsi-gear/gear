import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, afterEach, vi } from 'vitest'
import { openHitchSdk, type HitchEnvironment } from '../../src/adapters/hitch/sdk.js'
import { digestJson } from '../../src/adapters/hitch/json.js'
import type { HitchProfile } from '../../src/adapters/hitch/provider.js'
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-public-sdk-')); roots.push(root)
  await mkdir(join(root, 'bin'))
  const profile: HitchProfile = { kind: 'hitch', root, executable: join(root, 'bin/hitch.mjs'), harnessRef: 'pi@version:1.0.0', model: 'unused', passEnv: [], timeoutMs: 1000, baseImage: 'image@'+digestJson('image') }
  const expected: HitchEnvironment = { provider: 'local-docker', workerId: 'local', collisionDomainId: 'engine', environment: { schema_version: '2', host_platform: 'darwin-arm64',
    harbor: { status: 'available', version: '0.21.0', executable_digest: digestJson('harbor') },
    docker: { status: 'available', version: '28.1.0', executable_digest: digestJson('docker'), engine_id: 'engine', os: 'linux', architecture: 'aarch64' },
    buildx: { status: 'unavailable', version: null }, sandbox: { status: 'unverified' } },
    controller: { schema_version: '2', package_version: '0.2.16', node_version: 'v22.23.0', runtime_id: digestJson('controller'), source: { kind: 'unavailable', commit: null, dirty: null } } }
  const exports = Object.fromEntries(['controller-runtime', 'backends', 'evals', 'revisions'].map(name => ['./'+name, './sdk.mjs']))
  await writeFile(profile.executable, '', { mode: 0o700 })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent-hitch', type: 'module', exports }))
  const update = async (value: HitchEnvironment & { diagnostics?: unknown[]; waitForAbort?: boolean; ignoreDiagnostics?: boolean }) => writeFile(join(root, 'observed.json'), JSON.stringify(value))
  await update(expected)
  await writeFile(join(root, 'sdk.mjs'), `import {readFile} from 'node:fs/promises';const read=async()=>JSON.parse(await readFile(new URL('./observed.json',import.meta.url),'utf8'));export const observeControllerRuntime=async()=> (await read()).controller;const entered=Promise.withResolvers();export const waitForObservation=()=>entered.promise;export const observeHarborEnvironment=async({onDiagnostic,signal})=>{const value=await read();if(!value.ignoreDiagnostics)for(const diagnostic of value.diagnostics??[])onDiagnostic?.(diagnostic);entered.resolve();if(value.waitForAbort&&!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return value.environment;};`)
  return { profile, expected, update }
}
it('loads public APIs from an installed source-less package and checks the executing environment', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected), signal = new AbortController().signal
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  const observed = structuredClone(f.expected); observed.controller.node_version = 'v26.7.0'
  await f.update(observed)
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  observed.environment = { ...observed.environment, changed: true }; await f.update(observed)
  await expect(sdk.check(signal)).rejects.toMatchObject({ code: 'hitch-sdk-environment-mismatch' })
})
it('rejects mismatched payloads and refuses to reuse cached modules after an upgrade', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected)
  const changed = structuredClone(f.expected); changed.controller.runtime_id = digestJson('upgrade'); await f.update(changed)
  await expect(sdk.check(new AbortController().signal)).rejects.toMatchObject({ code: 'hitch-sdk-runtime-mismatch' })
  await expect(openHitchSdk(f.profile, changed)).rejects.toMatchObject({ code: 'hitch-sdk-runtime-changed' })
})
it('fails closed when a public preparation API is missing', async () => {
  const f = await fixture()
  await writeFile(join(f.profile.root, 'package.json'), JSON.stringify({ name: 'agent-hitch', exports: {} }))
  await expect(openHitchSdk(f.profile, f.expected)).rejects.toMatchObject({ code: 'hitch-sdk-unavailable' })
})
it('resolves a PATH-selected CLI to the same public SDK package as execution', async () => {
  const f = await fixture()
  vi.stubEnv('PATH', join(f.profile.root, 'bin'))
  const sdk = await openHitchSdk({ ...f.profile, executable: 'hitch.mjs' }, f.expected)
  await expect(sdk.check(new AbortController().signal)).resolves.toBeUndefined()
})

function diagnostic(overrides: Record<string, unknown> = {}) {
  return { probe: 'docker_info', attempt: 1, stage: 'command', outcome: 'nonzero_exit', elapsed_ms: 12, exit_code: 1, signal: null, ...overrides }
}
it('preserves safe SDK diagnostics for an unavailable provider instead of reporting identity drift', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected), probes = [
    diagnostic({ outcome: 'timed_out', elapsed_ms: 10_000, exit_code: null, signal: 'SIGTERM' }),
    diagnostic({ attempt: 2, stage: 'parse', outcome: 'invalid_json', exit_code: 0 }),
  ]
  const observed = structuredClone(f.expected)
  ;(observed.environment.docker as Record<string, unknown>).status = 'unavailable'
  await f.update({ ...observed, diagnostics: probes })
  const error = await sdk.check(new AbortController().signal).catch(error => error)
  expect(error).toMatchObject({ code: 'provider-environment-unavailable' })
  expect(JSON.parse(error.message.split('; diagnostics=')[1])).toEqual({ schema_version: '1', probes })
})
it('accepts old SDKs without callbacks and keeps safe diagnostics outside environment identity', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected), signal = new AbortController().signal
  await f.update({ ...f.expected, diagnostics: [diagnostic({ stage: 'complete', outcome: 'ok', exit_code: 0 })] })
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  await f.update({ ...f.expected, diagnostics: [diagnostic()], ignoreDiagnostics: true })
  await expect(sdk.check(signal)).resolves.toBeUndefined()
  const observed = structuredClone(f.expected)
  ;(observed.environment.docker as Record<string, unknown>).engine_id = 'replacement-engine'
  await f.update({ ...observed, diagnostics: [diagnostic()] })
  await expect(sdk.check(signal)).rejects.toMatchObject({ code: 'hitch-sdk-environment-mismatch' })
})
it.each([
  [diagnostic({ stderr: 'private-token' })],
  [diagnostic({ outcome: ['nonzero_exit'] })],
  [diagnostic({ attempt: 2 })],
  [diagnostic({ stage: 'complete', outcome: 'ok', exit_code: 1 })],
  [
    diagnostic({ probe: 'harbor_version', stage: 'complete', outcome: 'ok', exit_code: 0 }),
    diagnostic(), diagnostic({ attempt: 2 }), diagnostic({ probe: 'buildx_version' }),
    diagnostic({ stderr: 'private-token' }),
  ],
])('rejects malformed or excessive SDK callback metadata %#', async (...probes) => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected)
  await f.update({ ...f.expected, diagnostics: probes })
  const error = await sdk.check(new AbortController().signal).catch(error => error)
  expect(error).toMatchObject({ code: 'invalid-provider-environment' })
  expect(error.message).not.toContain('private-token')
})
it('keeps cancellation ahead of malformed callback metadata and unavailable results', async () => {
  const f = await fixture(), sdk = await openHitchSdk(f.profile, f.expected), abort = new AbortController(), reason = new Error('cancel preparation')
  const observed = structuredClone(f.expected)
  ;(observed.environment.docker as Record<string, unknown>).status = 'unavailable'
  await f.update({ ...observed, diagnostics: [diagnostic({ stderr: 'private-token' })], waitForAbort: true })
  const checked = sdk.check(abort.signal)
  await sdk.call('backends', 'waitForObservation')
  abort.abort(reason)
  await expect(checked).rejects.toBe(reason)
})
