const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const
type TokenField = (typeof tokenFields)[number]
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Native turn totals are not model request counts. Missing turns or fields remain unknown. */
export class CodexUsage {
  private turns = 0
  private active = 0
  private failed = false
  private totals: Record<TokenField, number | null> = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
  }

  record(line: string): void {
    let event: { type?: string; usage?: Record<string, unknown> }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      if (line.trim()) this.failed = true
      return
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    if (event.type === 'turn.started') this.active++
    if (event.type === 'turn.failed' || event.type === 'error') this.failed = true
    if (event.type !== 'turn.completed') return
    this.turns++
    this.active = Math.max(0, this.active - 1)
    const usage = event.usage
    for (const key of tokenFields) {
      const value = usage?.[key],
        total = this.totals[key]
      this.totals[key] = count(value) && total !== null && count(total + value) ? total + value : null
    }
    if (
      count(usage?.input_tokens) &&
      count(usage?.cached_input_tokens) &&
      usage.cached_input_tokens > usage.input_tokens
    )
      this.failed = true
  }

  result(processCompleted: boolean): Record<string, number | null> {
    const known = processCompleted && this.turns > 0 && this.active === 0 && !this.failed
    const tokens = Object.fromEntries(tokenFields.map((key) => [key, known ? this.totals[key] : null]))
    const input = tokens.input_tokens,
      output = tokens.output_tokens
    return {
      ...tokens,
      tokens: count(input) && count(output) && count(input + output) ? input + output : null,
      model_requests: null,
      dollars: null,
    }
  }
}
