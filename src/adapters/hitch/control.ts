import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { OperationRequest } from '../../ports/operations.js'
import { publishFile } from '../storage/atomic.js'

type Call = (args: string[], signal: AbortSignal) => Promise<Record<string, unknown>>
export function hitchOperationPath(directory: string, operationId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(operationId))
    throw new GearError('invalid-operation-id', 'Invalid operation ID')
  return join(directory, operationId.slice(7))
}
export interface ControlReply {
  schema_version: '2'
  eval_id: string
  subject_digest: string
  sequence: number
  action: 'start' | 'pause'
  submitted: boolean
  pending_reruns: boolean
}

/** Fixed transport sequence: a terminal pause fences even a delayed first submit. */
export class OrderedHitchControl {
  constructor(
    readonly directory: string,
    readonly identity: string,
    readonly call: Call,
  ) {}

  async intent(request: OperationRequest, repetition: number, action: 'start' | 'pause') {
    const body = {
      schema_version: '2',
      key: canonicalDigest([request.operationId, repetition]),
      subject_digest: canonicalDigest({ request, provider: this.identity }),
      sequence: action === 'start' ? 0 : 1,
      action,
    } as const
    const path = join(this.directory, `control-${repetition}-${action}.json`)
    await publishFile(path, JSON.stringify(body), { immutable: true })
    return { path, body }
  }

  validate(
    value: Record<string, unknown>,
    intent: Awaited<ReturnType<OrderedHitchControl['intent']>>,
    expectedId?: string | null,
  ): ControlReply {
    if (
      value.schema_version !== '2' ||
      typeof value.eval_id !== 'string' ||
      !/^eval_[a-f0-9]{32}$/u.test(value.eval_id) ||
      (expectedId && value.eval_id !== expectedId) ||
      value.subject_digest !== intent.body.subject_digest ||
      value.sequence !== intent.body.sequence ||
      value.action !== intent.body.action ||
      typeof value.submitted !== 'boolean' ||
      typeof value.pending_reruns !== 'boolean'
    )
      throw new GearError('hitch-control-invalid', 'Hitch control reply does not match the frozen intent')
    return value as unknown as ControlReply
  }

  async observe(
    request: OperationRequest,
    repetition: number,
    signal: AbortSignal,
    expectedId?: string | null,
  ) {
    const intent = await this.intent(request, repetition, 'start')
    // This command contains no submission. Replaying an interrupted registration
    // can reserve its ID, but can never launch a task or make a model request.
    const reply = this.validate(
      await this.call(['eval', 'control', '--file', intent.path], signal),
      intent,
      expectedId,
    )
    return { ...intent, reply }
  }

  async cancel(request: OperationRequest): Promise<void> {
    const signal = AbortSignal.timeout(15_000)
    const replies: ControlReply[] = []
    let incomplete = false
    // Fence every repetition, including ones whose local preparation never finished.
    for (const repetition of new Set(request.slots.map((slot) => slot.repetition))) {
      try {
        const intent = await this.intent(request, repetition, 'pause')
        replies.push(
          this.validate(await this.call(['eval', 'control', '--file', intent.path], signal), intent),
        )
      } catch {
        incomplete = true
      }
    }
    const deadline = Date.now() + 5000
    for (const reply of replies) {
      if (!reply.submitted && !reply.pending_reruns) continue
      try {
        for (;;) {
          const inspection = await this.call(['eval', 'inspect', reply.eval_id, '--json'], signal)
          const control = inspection.control as Record<string, unknown> | null
          if (
            !reply.pending_reruns &&
            inspection.schema_version === '1' &&
            inspection.eval_id === reply.eval_id &&
            control?.eval_id === reply.eval_id &&
            ['succeeded', 'failed', 'cancelled'].includes(String(control.state)) &&
            Array.isArray(control.active_leases) &&
            control.active_leases.length === 0
          )
            break
          if (Date.now() >= deadline) throw new Error('Cancellation is still pending')
          await delay(100, undefined, { signal })
        }
      } catch {
        incomplete = true
      }
    }
    if (incomplete)
      throw new GearError(
        'hitch-cancellation-unconfirmed',
        'Hitch has not confirmed all work stopped or fenced',
        { retryable: true },
      )
  }
}
