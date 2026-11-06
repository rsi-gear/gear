import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { HitchProfile } from './provider.js'
import type { ObservationCall } from './observation.js'
import { hitchCredentialMarginMs, hitchSettings } from './settings.js'

export interface HitchEnvironmentBinding {
  schema_version: '1'
  binding_id: string
  model: string
  pass_env: string[]
  expires_at_ms: number | null
}

/** Prepared by the resident executor, including its private credential helper result. */
export async function prepareEnvironmentBinding(
  profile: HitchProfile,
  call: ObservationCall,
  signal: AbortSignal,
): Promise<HitchEnvironmentBinding> {
  // Hitch's default environment setup allowance is separate from the agent deadline.
  const settings = hitchSettings(profile)
  const validity = profile.timeoutMs + settings.setupTimeoutMs + hitchCredentialMarginMs
  const result = await call(
    [
      'eval',
      'bind',
      '--model',
      profile.model,
      '--minimum-validity',
      `${validity}ms`,
      '--timeout',
      `${settings.preparationTimeoutMs}ms`,
      '--json',
      ...profile.passEnv.flatMap((name) => ['--pass-env', name]),
    ],
    signal,
    settings.preparationTimeoutMs,
  )
  const binding = result.binding as Partial<HitchEnvironmentBinding> | undefined
  if (
    result.schema_version !== '1' ||
    result.provider !== 'local-docker' ||
    typeof result.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(result.nonce) ||
    typeof result.daemon_instance_id !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(result.daemon_instance_id) ||
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(',') !== 'binding_id,expires_at_ms,model,pass_env,schema_version' ||
    binding.schema_version !== '1' ||
    typeof binding.binding_id !== 'string' ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(binding.binding_id) ||
    binding.model !== profile.model ||
    !Array.isArray(binding.pass_env) ||
    canonicalDigest(binding.pass_env) !== canonicalDigest([...new Set(profile.passEnv)].sort()) ||
    !(
      binding.expires_at_ms === null ||
      (Number.isSafeInteger(binding.expires_at_ms) &&
        binding.expires_at_ms! >= Date.now() + profile.timeoutMs)
    )
  ) {
    throw new GearError(
      'hitch-environment-binding',
      'Hitch did not freeze the requested model execution environment',
    )
  }
  return structuredClone(binding) as HitchEnvironmentBinding
}
