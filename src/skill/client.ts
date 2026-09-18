import { connect } from 'node:net'

export interface SkillClientRequest { id?: string; method: string; params?: unknown }

export async function requestRefineSkill(socketPath: string, request: SkillClientRequest): Promise<unknown> {
  const id = request.id ?? crypto.randomUUID()
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  const result = await new Promise<unknown>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
      socket.end()
    }
    socket.once('connect', () => socket.write(`${JSON.stringify({
      id,
      method: request.method,
      params: request.params ?? {},
    })}\n`))
    socket.once('error', error => finish(() => reject(error)))
    socket.once('close', () => {
      if (!settled) finish(() => reject(new Error('refine skill connection closed before a response')))
    })
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        if (response.id !== id) throw new Error('refine skill response id mismatch')
        if (typeof response.error === 'object' && response.error !== null) {
          throw new Error(String((response.error as Record<string, unknown>).message ?? 'refine skill request failed'))
        }
        finish(() => resolve(response.result))
      } catch (error) { finish(() => reject(error)) }
    })
  })
  return result
}
