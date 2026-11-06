import { randomUUID } from 'node:crypto'

/** Meter the HTTP boundary, so provider-internal retries reserve again. */
export function installModelBudget(budget, persist, { fetch = globalThis.fetch } = {}) {
  const wrapped = async (input, init) => {
    const request = new Request(input, init)
    if (request.method !== 'POST') return fetch(input, init)
    let body
    const text = await request.clone().text()
    try { body = JSON.parse(text) } catch { return fetch(input, init) }
    if (!body.model) return fetch(input, init)
    const path = new URL(request.url).pathname
    if (!/\/(responses|chat\/completions)$/.test(path)) throw new Error('hard token budget: unsupported provider wire protocol')
    const output = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
    if (!Number.isSafeInteger(output) || output <= 0) throw new Error('hard token budget requires an explicit provider-enforced output limit')
    // Text-only byte-level tokenizers: UTF-8 bytes bound text tokens. Include
    // wire/tool/schema bytes plus conservative message framing; reject media.
    if (/"(?:image_url|input_image|input_audio|file_id)"/.test(text)) throw new Error('hard token budget supports text-only requests')
    const inputBound = Buffer.byteLength(text) + 1024 + 64 * ((body.messages ?? body.input ?? []).length || 1)
    const id = `provider-${randomUUID()}`
    budget.request(id, inputBound, output); await persist()
    let settled = false, usage = null
    const settle = async () => {
      if (settled) return; settled = true
      const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens
      const outputTokens = usage?.output_tokens ?? usage?.completion_tokens
      if (Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
        budget.settle(id, { cpuSeconds: 0, requests: 1, tools: 0, tokens: inputTokens + outputTokens })
      } else budget.settle(id) // Failed/unknown requests retain their full reservation.
      await persist()
    }
    try {
      const response = await fetch(request)
      if (!response.body) { await settle(); return response }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''
      const inspect = line => {
        try { const value = JSON.parse(line.replace(/^data: ?/, '')); usage = value.usage ?? value.response?.usage ?? usage } catch {}
      }
      const bodyStream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) { if (pending) inspect(pending); await settle(); controller.close(); return }
            pending += decoder.decode(value, { stream: true })
            let newline
            while ((newline = pending.indexOf('\n')) !== -1) { inspect(pending.slice(0, newline)); pending = pending.slice(newline + 1) }
            if (pending.length > 1024 * 1024) throw new Error('unbounded provider response frame')
            controller.enqueue(value)
          } catch (e) { await reader.cancel(e); await settle(); controller.error(e) }
        },
        async cancel(reason) { await reader.cancel(reason); await settle() },
      })
      return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (e) { await settle(); throw e }
  }
  globalThis.fetch = wrapped
  return () => { if (globalThis.fetch === wrapped) globalThis.fetch = fetch }
}
