// Internal synchronous-call transport. Algorithm code stays in the frozen Python bundle.
const { parentPort, workerData } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const pid = new Int32Array(workerData.pid)
let pending, failure, output = '', stderr = ''
const child = spawn(workerData.python, ['-I', '-B', '-u', '-c', workerData.bootstrap], {
  env: workerData.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
})
if (child.pid) Atomics.store(pid, 0, child.pid)
function stop() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') }
  catch (error) { if (error.code !== 'ESRCH') failure = `Python policy cleanup failed: ${error.code}` }
}
function reply(json) {
  if (!pending) return
  const control = new Int32Array(pending.buffer, 0, 2)
  const bytes = Buffer.from(json)
  if (bytes.length > pending.buffer.byteLength - 8) {
    fail('Python policy reply exceeds the transport limit')
    return
  }
  new Uint8Array(pending.buffer, 8, bytes.length).set(bytes)
  Atomics.store(control, 1, bytes.length)
  Atomics.store(control, 0, 1)
  Atomics.notify(control, 0)
  pending = undefined
}
function fail(message) {
  failure = message
  reply(JSON.stringify({ error: message, type: 'TransportError' }))
  stop()
}
child.stdin.on('error', () => {})
child.on('error', error => fail(`Unable to start Python policy worker: ${error.code ?? error.message}`))
child.on('close', (code, signal) => {
  Atomics.store(pid, 0, 0)
  if (!failure) fail(`Python policy worker exited (${signal ?? code}): ${stderr}`)
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  output += chunk
  if (Buffer.byteLength(output) > workerData.maxBytes) {
    fail('Python policy reply exceeds the transport limit')
    return
  }
  const end = output.indexOf('\n')
  if (end < 0) return
  const json = output.slice(0, end)
  output = output.slice(end + 1)
  if (!pending || output.length) { fail('Python policy returned an unexpected frame'); return }
  reply(json)
})
child.stdin.write(JSON.stringify({ sources: workerData.sources }) + '\n')
parentPort.on('message', request => {
  if (pending) { fail('Python policy transport received overlapping requests'); return }
  pending = request
  if (failure) { reply(JSON.stringify({ error: failure, type: 'TransportError' })); return }
  child.stdin.write(request.json + '\n')
})
process.once('exit', stop)
