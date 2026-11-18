import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { Json } from '../domain/algorithm-wire.js'
import type { EnvironmentBindingRecovery, ExecutionIdentity } from '../ports/operations.js'
import type { HitchOperationProvider } from '../adapters/hitch/provider.js'
import { hitchJson } from '../adapters/hitch/transport.js'

/** Reconstruct both identities from the actual connection. No provider identity is overridden. */
export async function recoverHitchEnvironment(
  evaluation: HitchOperationProvider,
  metaIdentity: string,
  previous: ExecutionIdentity,
  binding: Json,
  signal: AbortSignal,
): Promise<EnvironmentBindingRecovery> {
  const fail = () =>
    new GearError(
      'environment-recovery-mismatch',
      'Only a changed host environment binding can be recovered; model, runtime, resources, artifacts, credentials selection and Meta must match',
    )
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(',') !== 'binding_id,expires_at_ms,model,pass_env,schema_version' ||
    typeof binding.binding_id !== 'string' ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(binding.binding_id)
  )
    throw fail()
  const { binding_id: _previous, ...oldConditions } = binding
  const { binding_id: _current, ...currentConditions } = evaluation.environmentBinding
  if (canonicalDigest(oldConditions) !== canonicalDigest(currentConditions)) throw fail()
  const invariant = {
    profile: evaluation.profile,
    runtime: evaluation.revisionIdentity,
    preparedArtifacts: evaluation.preparedArtifacts,
    capabilities: await hitchJson(
      evaluation.profile.executable,
      evaluation.profile.root,
      ['capabilities', '--json'],
      signal,
    ),
    executionEnvironment: evaluation.executionEnvironment,
    implementation: evaluation.context.implementationIdentity,
  }
  if (
    canonicalDigest({ ...invariant, environmentBinding: evaluation.environmentBinding }) !==
      evaluation.identity ||
    canonicalDigest({ ...invariant, environmentBinding: binding }) !== previous.evaluation ||
    canonicalDigest({ evaluation: previous.evaluation, meta: metaIdentity }) !== previous.provider
  )
    throw fail()
  return {
    version: 1,
    from: previous,
    to: {
      provider: canonicalDigest({ evaluation: evaluation.identity, meta: metaIdentity }),
      evaluation: evaluation.identity,
    },
    previousBinding: structuredClone(binding),
    currentBinding: structuredClone(evaluation.environmentBinding) as unknown as Json,
    invariantDigest: canonicalDigest(invariant),
  }
}
