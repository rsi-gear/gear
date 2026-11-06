// Runs the real CLI against an in-container deterministic chat-completions server.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const adapter = process.argv[2],
  marker = 'GEAR_HEADLESS_EXTENSION_OBSERVED',
  nativeEntrypoint = process.argv[3]
if (nativeEntrypoint) {
  assert(nativeEntrypoint.startsWith('/opt/hitch-artifact/'))
  assert.equal(process.version, process.argv[4], 'Prepared artifact Node contract differs')
}
const requests = []
assert(!existsSync('/tests/expected.json'), 'Candidate received private verifier data')
await mkdir('/tmp/home', { recursive: true })
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      assert(bytes < 4 * 1024 * 1024)
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.url, '/v1/chat/completions')
    assert(requests.length < 4, 'Unexpected additional model calls')
    const observed = body.messages.some(
      (message) =>
        ['system', 'developer'].includes(message.role) && JSON.stringify(message.content).includes(marker),
    )
    const toolResult = body.messages.some((message) => message.role === 'tool')
    requests.push({
      marker: observed,
      tool_result: toolResult,
      ...(toolResult
        ? {
            tool_result_text: JSON.stringify(
              body.messages.filter((message) => message.role === 'tool'),
            ).slice(0, 3000),
          }
        : {}),
    })
    const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: body.model }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    if (!toolResult) {
      assert(
        body.tools.some((tool) => tool.function.name === 'bash'),
        'Native bash tool was not offered',
      )
      const command = 'printf ' + (observed ? 'correct' : 'wrong') + ' > /app/answer.txt'
      const args =
        adapter === 'dsh' ? { command, description: 'Write the controlled test answer file' } : { command }
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-call',
                  type: 'function',
                  function: { name: 'bash', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Saved answer.' }, finish_reason: null }],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    response.end('data: [DONE]\n\n')
  } catch (error) {
    response.destroy(error)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1'
const task = 'Write the requested final answer to /app/answer.txt using the bash tool.'
let command, args
if (adapter === 'dsh') {
  await writeFile(
    '/tmp/runtime.json',
    JSON.stringify([
      {
        id: 'llm-deepseek',
        config: {
          baseURL: endpoint,
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          thinking: 'disabled',
          maxTokens: 512,
          models: [{ id: 'fixture', contextWindow: 32768, maxTokens: 512 }],
        },
      },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'fixture' } },
      { id: 'session-title-llm', disabled: true },
    ]),
  )
  command = 'dsh'
  args = [
    '--profile',
    'headless',
    '--patch',
    '/opt/gear-target.patch.yml',
    '--patch',
    '/tmp/runtime.json',
    '--',
    '--',
    task,
  ]
} else {
  await writeFile(
    '/tmp/provider.ts',
    `export default function(pi) { pi.registerProvider('gear-fixture', {
    baseUrl: ${JSON.stringify(endpoint)}, apiKey: 'fixture', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:32768, maxTokens:512 }]
  }) }`,
  )
  command = 'pi'
  args = [
    '--mode',
    'json',
    '--no-session',
    '--model',
    'gear-fixture/fixture',
    '--approve',
    '--offline',
    '--extension',
    '/tmp/provider.ts',
  ]
}
if (nativeEntrypoint) {
  args.unshift(nativeEntrypoint)
  command = process.execPath
}
const launchEnv = {
  PATH: process.env.PATH,
  HOME: '/tmp/home',
  DSH_HOME: '/tmp/home/dsh',
  PI_CODING_AGENT_DIR: '/tmp/home/pi',
  DEEPSEEK_API_KEY: 'fixture',
}
try {
  const { stdout: versionOutput } = await promisify(execFile)(
    command,
    [...(nativeEntrypoint ? [nativeEntrypoint] : []), '--version'],
    { env: launchEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 },
  )
  const version = versionOutput.trim()
  assert.equal(version, process.argv[5], 'CLI version differs from the Gear runtime matrix')
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: '/app',
      env: launchEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      failure
    const timer = setTimeout(() => {
      failure = new Error('Headless CLI timed out')
      child.kill('SIGKILL')
    }, 60000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) {
        failure = new Error('CLI stdout overflow')
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32768)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error('CLI exit ' + code + ': ' + stderr))
      else resolve({ stdout, stderr })
    })
    child.stdin.end(adapter === 'pi' ? task : '')
  })
  assert.equal(requests.length, 2, JSON.stringify({ requests, result }))
  assert.equal(requests[1].tool_result, true)
  assert(existsSync('/app/answer.txt'), JSON.stringify({ requests, result }))
  const answer = await readFile('/app/answer.txt', 'utf8')
  assert.equal(answer, requests[0].marker ? 'correct' : 'wrong')
  assert(result.stdout.includes('Saved answer.'))
  console.log(
    JSON.stringify({
      adapter,
      version,
      requests,
      answer,
      native_tool_executed: true,
      external_model_requests: 0,
    }),
  )
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
