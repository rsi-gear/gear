import { GearError } from '../../domain/errors.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type { HitchProfile } from './provider.js'
import { hitchJson } from './transport.js'
import { observeEvaluationEnvironment } from './observation.js'
import { isPinnedHarnessReference } from './reference.js'

export async function inspectHitchConnection(
  profile: HitchProfile,
  adapter: HarnessAdapter,
  signal: AbortSignal,
) {
  if (profile.passEnv.some((name) => /^GEAR_SCORER_[A-Z0-9_]+_API_KEY$/u.test(name)))
    throw new GearError(
      'verifier-credential-target',
      'Scorer credentials belong in the verifier worker environment, never Target passEnv',
    )
  const expected = adapter.describe().adapterRef.id === 'dsh' ? 'deepseek' : 'pi'
  if (
    !profile.harnessRef.startsWith(`${expected}@`) ||
    !isPinnedHarnessReference(profile.harnessRef) ||
    !/^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u.test(profile.baseImage)
  )
    throw new GearError(
      'unlocked-target-runtime',
      'Hitch profiles require the matching exact harness version or 40-character SHA-1 commit and an OCI image digest',
    )
  const runtime = await hitchJson(
    profile.executable,
    profile.root,
    ['resolve', profile.harnessRef, '--json'],
    signal,
  )
  const capabilities = await hitchJson(profile.executable, profile.root, ['capabilities', '--json'], signal)
  if (
    capabilities.schema_version !== '1' ||
    capabilities.ordered_eval_control !== '2' ||
    capabilities.controller_runtime_observation !== '2' ||
    capabilities.local_execution_observation !== '2' ||
    capabilities.evaluation_environment_binding !== '3' ||
    capabilities.evaluation_preparation !== '1' ||
    capabilities.evaluation_artifact_pins !== '1'
  )
    throw new GearError(
      'hitch-capability-missing',
      'Hitch must support ordered evaluation control v2, execution observations v2, environment bindings v3, configurable preparation v1 and artifact pins v1',
    )
  const executionEnvironment = await observeEvaluationEnvironment(
    (args, signal, timeout) => hitchJson(profile.executable, profile.root, args, signal, timeout),
    signal,
  )
  if (typeof runtime.identity !== 'string')
    throw new GearError('hitch-identity-missing', 'Hitch did not resolve an immutable runtime')
  return { revisionIdentity: runtime.identity, capabilities, executionEnvironment }
}

export const hitchCapabilities = {
  seeds: false,
  temperature: false,
  subsets: true,
  idempotentSubmission: true,
  inspect: true,
  cancel: true,
  physicalAttemptAccounting: true,
  evidenceProjection: true,
  hardDollarBudget: false,
  generationBudget: false,
}
