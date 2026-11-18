import { afterEach, expect, it, vi } from 'vitest'
import { recoverHitchEnvironment } from '../../src/application/environment-recovery.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import * as transport from '../../src/adapters/hitch/transport.js'

afterEach(() => vi.restoreAllMocks())
function fixture() {
  const binding = { schema_version: '1', binding_id: `hmac-sha256:${'a'.repeat(64)}`, model: 'model', pass_env: ['TOKEN'], expires_at_ms: null }
  const current = { ...binding, binding_id: `hmac-sha256:${'b'.repeat(64)}` }
  const invariant = { profile: { executable: '/hitch', root: '/root', model: 'model', maxConcurrent: 4 }, runtime: canonicalDigest('runtime'), preparedArtifacts: [{ artifact: canonicalDigest('artifact') }], capabilities: { evaluation_environment_binding: '3' }, executionEnvironment: { provider: 'local-docker' }, implementation: canonicalDigest('implementation') }
  const oldIdentity = canonicalDigest({ ...invariant, environmentBinding: binding })
  const identity = canonicalDigest({ ...invariant, environmentBinding: current })
  const meta = canonicalDigest('meta')
  const evaluation = { ...invariant, identity, environmentBinding: current, revisionIdentity: invariant.runtime, context: { implementationIdentity: invariant.implementation } } as unknown as HitchOperationProvider
  vi.spyOn(transport, 'hitchJson').mockResolvedValue(invariant.capabilities)
  return { evaluation, binding, meta, previous: { evaluation: oldIdentity, provider: canonicalDigest({ evaluation: oldIdentity, meta }) } }
}
it('proves only the public binding changed, retaining actual connection identity', async () => {
  const { evaluation, binding, meta, previous } = fixture()
  const identity = evaluation.identity
  const proof = await recoverHitchEnvironment(evaluation, meta, previous, binding, new AbortController().signal)
  expect(proof.from).toEqual(previous)
  expect(proof.to.evaluation).toBe(identity)
  expect(proof.to.provider).not.toBe(previous.provider)
  expect(evaluation.identity).toBe(identity)
  expect(proof.previousBinding).toEqual(binding)
})
it('rejects changed Meta, code, resources, artifacts, model, credential selection and expiry', async () => {
  const base = fixture()
  for (const change of [
    { context: { implementationIdentity: canonicalDigest('different-code') } },
    { preparedArtifacts: [] },
    { profile: { ...base.evaluation.profile, maxConcurrent: 8 } },
    { revisionIdentity: canonicalDigest('different-runtime') },
  ]) {
    const changed = { ...base.evaluation, ...change }
    const evaluation = { ...changed, identity: canonicalDigest({
      profile: changed.profile, runtime: changed.revisionIdentity, preparedArtifacts: changed.preparedArtifacts,
      capabilities: { evaluation_environment_binding: '3' }, executionEnvironment: changed.executionEnvironment,
      implementation: changed.context.implementationIdentity, environmentBinding: changed.environmentBinding,
    }) } as unknown as HitchOperationProvider
    await expect(recoverHitchEnvironment(evaluation, base.meta, base.previous, base.binding, new AbortController().signal)).rejects.toThrow('Only a changed host environment binding')
  }
  for (const change of [{ model: 'other' }, { pass_env: [] }, { expires_at_ms: 42 }, { extra: 'field' }])
    await expect(recoverHitchEnvironment(base.evaluation, base.meta, base.previous, { ...base.binding, ...change }, new AbortController().signal)).rejects.toThrow()
  await expect(recoverHitchEnvironment(base.evaluation, canonicalDigest('other-meta'), base.previous, base.binding, new AbortController().signal)).rejects.toThrow()
})
