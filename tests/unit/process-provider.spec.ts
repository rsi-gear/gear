import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HitchArtifactReader } from '../../src/adapters/hitch/trajectory.js'
import { ProcessOperationProvider } from '../../src/adapters/process/operation-provider.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { artifactReader } from '../../src/adapters/artifacts/reader.js'
import type { OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const request: OperationRequest = {
  operationId: canonicalDigest('cancel-operation'), runId: 'run', generation: 1,
  operation: { kind: 'diagnose_seed', candidate_id: 'anchor', parent_id: null,
    task_ids: ['a'], scope: 'global', rationale: 'fixture', payload: null },
  partition: 'seed', repetitions: 1, slots: [], evidence: [],
}
async function provider(reply: unknown, reader?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'gear-cancel-contract-')); roots.push(root)
  const script = join(root, 'provider.mjs')
  await writeFile(script, `let text='';for await (const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text);
const result=input.action==='describe'?{version:1,identity:'${canonicalDigest('fixture-v1')}',
 ...(input.configuration.reader ? {artifactReader: input.configuration.reader} : {}), capabilities:{seeds:true,temperature:true,subsets:true,idempotentSubmission:true,inspect:true,cancel:true,physicalAttemptAccounting:true,generationBudget:false,hardDollarBudget:false,evidenceProjection:false}}
 :input.configuration.reply;
process.stdout.write(JSON.stringify(result));`)
  return ProcessOperationProvider.connect({ command: [process.execPath, script], workingDirectory: root,
    passEnv: [], configuration: { reply, ...(reader === undefined ? {} : { reader }) }, timeoutMs: 2000 })
}
it.each([null, {}, { cancelled: false }, { cancelled: 'true' }])('rejects an unconfirmed cancel response %j', async reply => {
  await expect((await provider(reply)).cancel(request)).rejects.toMatchObject({ code: 'provider-cancellation-unconfirmed' })
})
it('accepts explicit confirmation that work stopped or cannot start', async () => {
  await expect((await provider({ cancelled: true })).cancel(request)).resolves.toBeUndefined()
})
it('refuses unsupported generation limits before invoking submit', async () => {
  const adapter = await provider({ wouldBeInvalidReceipt: true })
  await expect(adapter.submit({ ...request, generationLimits: { tokens: 100 } }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'generation-budget-unsupported' })
})
it('binds the execution timeout while keeping per-run paths out of reusable execution identity', async () => {
  const adapter = await provider({ cancelled: true })
  const same = await ProcessOperationProvider.connect(adapter.profile, { runId: 'another-run', targets: '/different/run/targets' })
  expect(same.identity).toBe(adapter.identity)
  const changed = await ProcessOperationProvider.connect({ ...adapter.profile, timeoutMs: adapter.profile.timeoutMs + 1 })
  expect(changed.identity).not.toBe(adapter.identity)
  expect(changed.timeouts.target).toEqual([{ name: 'process-invocation', scope: 'provider-call', milliseconds: 2001 }])
})

it('reconstructs a cancellation connection without running describe or changing the original protocol inputs', async () => {
  const adapter = await provider({ cancelled: true }), expected = adapter.implementationIdentity
  await writeFile(adapter.profile.command[1]!, `let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);if(input.action!=='cancel'||input.implementationIdentity!==${JSON.stringify(expected)}||input.configuration.reply.cancelled!==true)process.exit(2);process.stdout.write(JSON.stringify({cancelled:true}));`)
  const cancel = await configuredCancellation(adapter.cancellation)
  expect(Object.keys(cancel)).toEqual(['cancel'])
  await expect(cancel.cancel(request)).resolves.toBeUndefined()
})

it('binds and exposes a supported immutable artifact reader from the process handshake', async () => {
  const reader = new HitchArtifactReader('/fixture/hitch', '/fixture/root').descriptor
  const connected = await provider({ cancelled: true }, reader)
  expect(connected.artifactReader).toEqual(reader)
  const moved = new HitchArtifactReader('/fixture/hitch', '/fixture/other').descriptor
  const changed = await ProcessOperationProvider.connect({ ...connected.profile,
    configuration: { reply: { cancelled: true }, reader: moved } })
  expect(changed.identity).not.toBe(connected.identity)
  await expect(provider({}, { ...reader, format: 'unknown' })).rejects.toMatchObject({ code: 'artifact-reader-unavailable' })
  await expect(provider({}, { ...reader, implementation_identity: canonicalDigest('forged') })).rejects.toMatchObject({ code: 'artifact-reader-changed' })
})

it('binds a public reader configuration locally and requires the frozen identity on resume', async () => {
  const descriptor = new HitchArtifactReader('/fixture/hitch', '/fixture/root').descriptor
  const { implementation_identity: _, ...configuration } = descriptor
  const connected = await provider({}, configuration)
  expect(connected.artifactReader).toEqual(descriptor)
  expect(artifactReader(connected.artifactReader!).descriptor).toEqual(descriptor)
  expect(() => artifactReader(configuration as typeof descriptor)).toThrow('identity is missing')
  const changed = await ProcessOperationProvider.connect({
    ...connected.profile,
    configuration: { reader: configuration, experiment: { version: 'v2', seed: 7 } },
  })
  expect(changed.identity).not.toBe(connected.identity)
})
