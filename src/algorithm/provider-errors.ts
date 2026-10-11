/** A verified provider contract violation, distinct from an uncertain transport failure.
 * The operation's reservation remains held; callers see the defect in this run.
 */
export class ProviderProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderProtocolError'
  }
}

/** An idempotent publication failed in this invocation; its durable intent must be reconciled. */
export class ProviderReconcileError extends ProviderProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderReconcileError'
  }
}
