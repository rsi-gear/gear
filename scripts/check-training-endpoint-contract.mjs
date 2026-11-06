// CPU contract smoke against a separately built Hitch. Uses a local daemon and controlled HTTP endpoint; no Harbor or GPU.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { digestJson } from '../lib/training/digest.js'
import { sealModelVersion } from '../lib/training/schema.js'
import { TrainingContentStore } from '../lib/training/store.js'
import { validateReadyEndpointBinding, publicEndpointBinding } from '../lib/training/endpoint-binding.js'

const executable = process.env.GEAR_TEST_HITCH
assert(executable, 'Set GEAR_TEST_HITCH to the companion built dist/bin/hitch.js or executable')
const dist = process.env.GEAR_TEST_HITCH_DIST ?? resolve(dirname(executable), '..')
const [{ parseEvalRequest }, { freezeEndpointRequest }] = await Promise.all([
  import(pathToFileURL(join(dist, 'src/cli/arguments.js')).href),
  import(pathToFileURL(join(dist, 'src/model-access/index.js')).href),
])
const root = await mkdtemp(join(tmpdir(), 'gear-hitch-endpoint-contract-')), execute = promisify(execFile)
const secret = 'endpoint-contract-private-test-value', requests = []
const env = { ...process.env, GEAR_ENDPOINT_CONTRACT_KEY: secret }
let daemon, daemonClosed = false, daemonExit
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  assert.equal(request.url, '/existing/prefix/chat/completions')
  assert.equal(request.headers.authorization, `Bearer ${secret}`)
  assert.equal(payload.max_tokens, 1024)
  requests.push(payload)
  const emitsTool = payload.tool_choice && payload.tool_choice !== 'none'
  const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
  if (payload.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = choices => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-contract', object: 'chat.completion.chunk', model: payload.model, choices })}\n\n`)
    if (emitsTool) {
      chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'verify-call', type: 'function', function: { name: 'hitch_verify', arguments: '{' } }] }, finish_reason: null }])
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: null }])
    } else chunk([{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: emitsTool ? 'tool_calls' : 'stop' }])
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-contract', object: 'chat.completion.chunk', model: payload.model, choices: [], usage })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else {
    const message = emitsTool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'verify-call', type: 'function', function: { name: 'hitch_verify', arguments: '{}' } }] }
      : { role: 'assistant', content: 'ready' }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ model: payload.model, choices: [{ index: 0, message, finish_reason: emitsTool ? 'tool_calls' : 'stop' }], usage }))
  }
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
try {
  const address = server.address(), store = new TrainingContentStore(join(root, 'store'))
  const hfSnapshotRef = await store.putJson({ immutable: 'HF snapshot fixture' })
  const model = sealModelVersion({ schemaVersion: 1, hfSnapshotRef, weightsDigest: digestJson('weights'), tokenizerDigest: digestJson('tokenizer'),
    chatTemplateDigest: digestJson('template'), architecture: 'FixtureForCausalLM', dtype: 'float32', provenanceRef: hfSnapshotRef })
  const config = { schema_version: '1', base_url: `http://127.0.0.1:${address.port}/existing/prefix`, wire_model: 'candidate-v1', api: 'chat-completions',
    auth: { kind: 'env', name: 'GEAR_ENDPOINT_CONTRACT_KEY' }, capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ['text'] } }
  const endpointFile = join(root, 'endpoint.json'), bindingFile = join(root, 'binding.json')
  await writeFile(endpointFile, JSON.stringify(config))
  const json = async args => {
    const command = executable.endsWith('.js') || executable.endsWith('.mjs') ? process.execPath : executable
    const argv = command === process.execPath ? [executable, '--root', root, ...args] : ['--root', root, ...args]
    return JSON.parse((await execute(command, argv, { env, encoding: 'utf8', timeout: 60_000 })).stdout)
  }
  const registered = await json(['models', 'connect', '--name', 'gear-candidate', '--file', endpointFile, '--json'])
  assert.equal(registered.endpoint_revision, digestJson(config))
  const inspected = await json(['models', 'inspect', 'endpoint/gear-candidate', '--verify', '--json'])
  assert.equal(inspected.verification.tool_calls, true)
  assert.equal(inspected.verification.streamed_tool_calls, true)
  assert.equal(requests.length, 6)
  for (const stream of [false, true]) assert(requests.some(payload => Boolean(payload.stream) === stream && payload.messages.some(message => message.role === 'tool')))
  for (const value of [registered, inspected]) {
    assert(!JSON.stringify(value).includes(config.base_url)); assert(!JSON.stringify(value).includes(secret))
    assert(!JSON.stringify(value).includes('GEAR_ENDPOINT_CONTRACT_KEY'))
  }
  const service = { engine: 'contract-http', engine_version: '1', cache_policy: 'shared' }, generation = { max_output_tokens: 1024, temperature: 0 }
  const binding = { schema_version: '1', kind: 'external-endpoint', endpoint_ref: 'endpoint/gear-candidate', endpoint_revision: registered.endpoint_revision,
    api: config.api, wire_model: config.wire_model, capabilities: config.capabilities, generation,
    connection: { base_url: config.base_url, auth: config.auth }, deployment_receipt: { schema_version: '1', model_digest: hfSnapshotRef.digest,
      wire_model: config.wire_model, deployment_ref: 'contract-deployment-v1', source: 'contract-deployer', service_config: service } }
  const common = { runtimeDigest: digestJson(service), protocolDigest: digestJson({ api: config.api }), samplingDigest: digestJson(generation), budgetsDigest: digestJson('budget'), attempts: 1 }
  validateReadyEndpointBinding(binding, model, common, ['contract-deployer'])
  await writeFile(bindingFile, JSON.stringify(binding))
  const flags = ['--dataset', 'contract-dataset', '--harness', `training-tool@commit:${'a'.repeat(40)}`, '--model', binding.endpoint_ref,
    '--model-binding-file', bindingFile, '--max-concurrent', '16', '--infrastructure-retries', '0']
  const argv = [...flags], request = parseEvalRequest(argv)
  assert.deepEqual(argv, [])
  const frozen = await freezeEndpointRequest(root, request, env)
  assert.deepEqual(frozen.endpoint_binding, publicEndpointBinding(binding))
  assert(!JSON.stringify(frozen).includes(config.base_url)); assert(!JSON.stringify(frozen).includes(secret)); assert(!('model_binding' in frozen))
  await assert.rejects(freezeEndpointRequest(root, { ...request, generation: { max_output_tokens: 4096 } }, env), /generation conflicts/)
  assert.throws(() => validateReadyEndpointBinding({ ...binding, deployment_receipt: { ...binding.deployment_receipt, model_digest: digestJson('other-model') } },
    model, common, ['contract-deployer']), { code: 'deployment-model-mismatch' })
  const daemonCommand = executable.endsWith('.js') || executable.endsWith('.mjs') ? process.execPath : executable
  const daemonArgs = ['--root', root, 'daemon', 'serve', '--port', '0', '--capacity-cpu-millis', '1000', '--capacity-memory-mib', '1024', '--container-slots', '1', '--build-slots', '1']
  daemon = spawn(daemonCommand, daemonCommand === process.execPath ? [executable, ...daemonArgs] : daemonArgs,
    { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let daemonDiagnostics = ''
  daemon.stderr.on('data', chunk => { daemonDiagnostics = (daemonDiagnostics + chunk).slice(-4096) })
  daemonExit = new Promise(done => { daemon.once('close', () => { daemonClosed = true; done() }); daemon.once('error', () => { daemonClosed = true; done() }) })
  let daemonReady = false
  for (let attempt = 0; attempt < 60 && !daemonClosed; attempt++) {
    if (await json(['daemon', 'status', '--json']).then(status => status.status === 'running', () => false)) { daemonReady = true; break }
    await delay(100)
  }
  assert(daemonReady, `companion Hitch daemon did not start: ${daemonDiagnostics}`)
  const accepted = await json(['eval', 'submit', '--dataset', 'demo@1.0', '--harness', `training-tool@commit:${'a'.repeat(40)}`,
    '--model', binding.endpoint_ref, '--model-binding-file', bindingFile, '--attempts', '1', '--max-concurrent', '1',
    '--infrastructure-retries', '0', '--build-mode', 'backend'])
  assert.match(accepted.eval_id, /^eval_[a-f0-9]{32}$/)
  const actualInspection = await json(['eval', 'inspect', accepted.eval_id, '--json'])
  assert.deepEqual(actualInspection.request.endpoint_binding, publicEndpointBinding(binding))
  assert(!JSON.stringify(actualInspection).includes(config.base_url)); assert(!JSON.stringify(actualInspection).includes(secret))
  await writeFile(endpointFile, JSON.stringify({ ...config, wire_model: 'candidate-v2' }))
  const changed = await json(['models', 'connect', '--name', 'gear-candidate', '--file', endpointFile, '--json'])
  assert.notEqual(changed.endpoint_revision, frozen.endpoint_binding.endpoint_revision)
  const restored = await freezeEndpointRequest(root, frozen, env)
  assert.deepEqual(restored.endpoint_binding, frozen.endpoint_binding)
  assert.deepEqual(JSON.parse(await readFile(bindingFile, 'utf8')), binding)
  console.log(JSON.stringify({ actualHitchCli: true, readyBindingFileAccepted: true, actualEvalSubmitAccepted: true, trainingToolChatToolsVerified: true, streamedToolRoundtripVerified: true,
    wrongModelDigestRejected: true, generationConflictRejected: true, aliasUpdateRetainsFrozenRevision: true,
    publicConnectionRedacted: true, normalRequestBudget: 1024, protocolVerificationRequests: requests.length,
    gpuAcceptance: 'not-run', fullHarborEvaluation: 'not-run' }))
} finally {
  if (daemon && !daemonClosed) {
    daemon.kill('SIGTERM')
    await Promise.race([daemonExit, delay(5000)])
    if (!daemonClosed) { daemon.kill('SIGKILL'); await Promise.race([daemonExit, delay(5000)]) }
    assert(daemonClosed, 'companion daemon termination was not confirmed')
  }
  await new Promise(done => server.close(done))
  await rm(root, { recursive: true, force: true })
}
