import { GearError } from '../../domain/errors.js'

export const defaultHitchConcurrency = 4
export const defaultPreparationTimeoutMs = 30 * 60_000
export const defaultSetupTimeoutMs = 30 * 60_000
export const hitchCredentialMarginMs = 5 * 60_000
export const hitchControlTimeoutMs = 30_000
export const hitchEnvironmentTimeoutMs = 55_000
// These are bounds imposed by Hitch's binding protocol and Node's timers.
const maxTaskAndSetupMs = 24 * 60 * 60_000
const maxTimerDelayMs = 2 ** 31 - 1

export interface HitchSettings {
  maxConcurrent: number
  preparationTimeoutMs: number
  setupTimeoutMs: number
}

/** Native argv is public and frozen; pass credential environment names through passEnv. */
export function hitchAgentArgs(profile: { agentArgs?: unknown }): string[] {
  if (profile.agentArgs === undefined) return []
  if (
    !Array.isArray(profile.agentArgs) ||
    profile.agentArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new GearError('invalid-profile', 'agentArgs must be an array of strings without NUL bytes')
  return [...profile.agentArgs] as string[]
}

export function hitchSettings(profile: Partial<HitchSettings> & { timeoutMs: number }): HitchSettings {
  for (const key of ['maxConcurrent', 'preparationTimeoutMs', 'setupTimeoutMs'] as const) {
    if (profile[key] !== undefined && !Number.isSafeInteger(profile[key])) {
      throw new GearError('invalid-profile', `${key} must be an integer`)
    }
  }
  const value = {
    // Existing profiles retain their previous execution condition. New profiles
    // write the selected concurrency explicitly so it enters the frozen identity.
    maxConcurrent: profile.maxConcurrent ?? 1,
    preparationTimeoutMs: profile.preparationTimeoutMs ?? defaultPreparationTimeoutMs,
    setupTimeoutMs: profile.setupTimeoutMs ?? defaultSetupTimeoutMs,
  }
  if (
    !Number.isSafeInteger(value.maxConcurrent) ||
    value.maxConcurrent < 1 ||
    !Number.isSafeInteger(value.preparationTimeoutMs) ||
    value.preparationTimeoutMs < 1 ||
    value.preparationTimeoutMs > maxTimerDelayMs ||
    !Number.isSafeInteger(value.setupTimeoutMs) ||
    value.setupTimeoutMs < 0 ||
    !Number.isSafeInteger(profile.timeoutMs) ||
    profile.timeoutMs < 1 ||
    profile.timeoutMs + value.setupTimeoutMs > maxTaskAndSetupMs
  ) {
    throw new GearError(
      'invalid-profile',
      'Hitch requires positive integer maxConcurrent and preparationTimeoutMs, a Node-compatible preparation timer, and nonnegative setupTimeoutMs with timeoutMs + setupTimeoutMs at most 24 hours',
    )
  }
  return value
}

/** A group can run serially when the daemon has less capacity than requested.
 * Allow each task's setup/agent budget, plus queue/preparation and reply time. */
export function evaluationWatchTimeoutMs(
  profile: Partial<HitchSettings> & { timeoutMs: number },
  tasks: number,
): number {
  const settings = hitchSettings(profile)
  return Math.min(
    maxTimerDelayMs,
    settings.preparationTimeoutMs +
      tasks * (profile.timeoutMs + settings.setupTimeoutMs) +
      hitchControlTimeoutMs,
  )
}
