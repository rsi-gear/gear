import type { BaselineReuseBlocker } from '../types.js'

/** A failed reuse check must never implicitly authorize another Target rollout. */
export class BaselineReuseBlockedError extends Error {
  readonly code: BaselineReuseBlocker['code']

  constructor(readonly blocker: BaselineReuseBlocker, options?: ErrorOptions) {
    super(blocker.reason, options)
    this.name = 'BaselineReuseBlockedError'
    this.code = blocker.code
  }
}
