import { addCost, assert, clone, cost, defaultBudget, dimensions, finite, validateBudget, zeroCost } from './contracts.mjs'

/** Reservation includes every in-flight provider request; unknown usage stays charged. */
export class Budget {
  constructor(limits = defaultBudget, state = null, now = () => Date.now()) {
    this.limits = clone(validateBudget(limits)); this.now = now
    this.state = state ? clone(state) : { startedAt: now(), used: zeroCost(), reservations: {}, events: [] }
    cost(this.state.used)
  }
  available(final = false) {
    const reserved = Object.values(this.state.reservations).reduce(addCost, zeroCost())
    const remaining = Object.fromEntries(dimensions.map(k => [k, this.limits[k] === null ? null : this.limits[k] - this.state.used[k] - reserved[k]]))
    if (!final) { remaining.cpuSeconds -= this.limits.reserveCpuSeconds; remaining.tools -= this.limits.reserveTools }
    return { ...remaining, wallSeconds: Math.max(0, this.limits.wallSeconds - (final ? 0 : this.limits.reserveSeconds) - (this.now() - this.state.startedAt) / 1000) }
  }
  reserve(id, upper, final = false) {
    cost(upper); assert(!Object.hasOwn(this.state.reservations, id) && !this.state.events.some(e => e.id === id), 'duplicate budget event')
    const remaining = this.available(final)
    assert(remaining.wallSeconds > 0 && dimensions.every(k => remaining[k] === null || upper[k] <= remaining[k]), 'budget exhausted')
    this.state.reservations[id] = clone(upper)
    return clone(upper)
  }
  settle(id, actual = null) {
    const held = this.state.reservations[id]; assert(held, 'missing budget reservation')
    const used = actual === null ? held : cost(actual)
    assert(dimensions.every(k => this.limits[k] === null || used[k] <= held[k]), 'usage exceeded reserved upper bound')
    this.state.used = addCost(this.state.used, used)
    this.state.events.push({ id, cost: clone(used), measured: actual !== null }); delete this.state.reservations[id]
  }
  request(id, fullInputUpperBound, maxOutputTokens) {
    finite(fullInputUpperBound, 'input token bound'); finite(maxOutputTokens, 'max output tokens')
    assert(Number.isSafeInteger(fullInputUpperBound) && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0, 'invalid token reservation')
    return this.reserve(id, { ...zeroCost(), requests: 1, tokens: fullInputUpperBound + maxOutputTokens })
  }
  observeModel(id, tokens, usageKnown) {
    assert(this.limits.tokens === null && this.limits.requests === null, 'observational accounting requires explicit unbounded model limits')
    assert(!this.state.events.some(e => e.id === id), 'duplicate observation')
    const actual = { ...zeroCost(), tokens, requests: 1 }; cost(actual)
    this.state.used = addCost(this.state.used, actual)
    this.state.events.push({ id, cost: actual, measured: usageKnown, requestCoverage: 'adapter-calls-lower-bound', price: 'unknown' })
  }
  snapshot() { return clone(this.state) }
}
