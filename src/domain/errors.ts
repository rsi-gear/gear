export class GearError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      location?: string
      retryable?: boolean
      next_action?: string
      run_id?: string
      operation_id?: string
    } = {},
  ) {
    super(message)
    this.name = 'GearError'
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: false, ...this.details }
  }
}
