import type { Json, VerifierObservation } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { builtinPolicy } from '../python/builtin-policy.js'
import { hitchJson } from './transport.js'

export interface VerifierCapture {
  run_id: string
  task_id: string
  repetition: number
  observation: VerifierObservation
  /** Operator-only source. Never part of the algorithm/Meta evidence projection. */
  source: Json
}

export async function captureVerifiers(
  executable: string,
  root: string,
  enabled: boolean,
  result: Record<string, unknown>,
  repetition: number,
  signal: AbortSignal,
): Promise<VerifierCapture[]> {
  const trials = result.trials as Array<Record<string, unknown>>
  const captures: VerifierCapture[] = []
  for (let index = 0; index < trials.length; index += 4) {
    const batch = await Promise.allSettled(
      trials.slice(index, index + 4).map(async (trial) => {
        let source: Json = null
        if (enabled) {
          try {
            const value = (await hitchJson(
              executable,
              root,
              ['verifier', 'inspect', String(trial.run_id), '--json'],
              signal,
              30_000,
              8 * 1024 * 1024,
            )) as Json
            canonicalDigest(value) // Only representable source JSON can enter an immutable receipt.
            source = value
          } catch {
            signal.throwIfAborted()
          }
        }
        const observation = builtinPolicy<VerifierObservation>('verifier_project', {
          source,
          trial,
          eval_id: result.eval_id,
          unsupported: !enabled,
        })
        return {
          run_id: String(trial.run_id),
          task_id: String(trial.task_id),
          repetition,
          source,
          observation,
        }
      }),
    )
    for (const value of batch) {
      if (value.status === 'rejected') throw value.reason
      captures.push(value.value)
    }
  }
  return captures
}

/** A new original-artifact projection cannot rewrite already certified verifier channels. */
export function verifyVerifierExtension(original: VerifierCapture | undefined, fresh: VerifierCapture): void {
  if (!original || original.observation.status !== 'available') return
  const before = original.observation,
    after = fresh.observation
  const payload = (capture: VerifierCapture) =>
    (capture.source as { verifier?: Record<string, Json> }).verifier ?? {}
  const artifacts = (capture: VerifierCapture) =>
    (capture.source as { verifier?: { structured_artifacts?: Record<string, Json> } }).verifier
      ?.structured_artifacts ?? {}
  if (
    after.status !== 'available' ||
    before.result_digest !== after.result_digest ||
    Object.entries(artifacts(original)).some(
      ([name, value]) => canonicalDigest(value) !== canonicalDigest(artifacts(fresh)[name] ?? null),
    ) ||
    ['process', 'feedback'].some(
      (name) =>
        Object.hasOwn(payload(original), name) &&
        canonicalDigest(payload(original)[name]) !== canonicalDigest(payload(fresh)[name] ?? null),
    )
  )
    throw new GearError(
      'hitch-verifier-source-changed',
      'A certified verifier source changed during original-artifact projection',
    )
}
