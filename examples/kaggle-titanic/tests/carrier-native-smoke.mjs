// Run inside the disposable carrier image with installed pinned dependencies
// and a synthetic /opt/hitch-harness-artifact/artifact.json. The loopback server
// is explicitly a test fixture: no model response, prediction or trace is faked.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'kaggle-native-fixture-'))
const requests = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  requests.push(JSON.parse(body))
  response.writeHead(401, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'native fixture boundary reached', type: 'authentication_error' } }))
})
await new Promise(accept => server.listen(0, '127.0.0.1', accept))
try {
  const patch = join(home, 'fixture.patch.yml')
  await writeFile(patch, '- id: session-title-llm\n  disabled: true\n')
  const child = spawn(process.execPath, [resolve(process.argv[2] ?? 'apps/cli/lib/bin.js'), '--profile', 'headless',
    '--patch', patch, '--', 'Exercise the native model boundary.'], {
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home,
      DEEPSEEK_API_KEY: 'synthetic-fixture-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  clearTimeout(timeout)
  assert.equal(code, 1, output)
  assert.match(output, /native fixture boundary reached/)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['run_pipeline'])
  assert.equal(requests[0].tools[0].function.parameters.additionalProperties, false)
  assert.match(JSON.stringify(requests[0].messages), /Call run_pipeline exactly once/)
  console.log('native DSH passed: fixed profile, real plugin boot, sole native run_pipeline tool, closed arguments, fixed prompt, loopback fixture boundary')
} finally {
  await new Promise(accept => server.close(accept))
  await rm(home, { recursive: true, force: true })
}
