import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerBenchmarkProbe } from '../lib/adapters/hitch/benchmark-probe.js'
import { pythonJson } from '../lib/application/python.js'

const image = process.env.GEAR_TEST_BENCHMARK_IMAGE
if (!image) throw new Error('Set GEAR_TEST_BENCHMARK_IMAGE to a pinned Python image')
const root = await mkdtemp(join(tmpdir(), 'gear-llm-protocol-'))
const execute = promisify(execFile), runner = new DockerBenchmarkProbe()
const signal = new AbortController().signal
const report = { synthetic_judge: true, external_model_calls: 0, root, results: [], passed: false }
try {
  await writeFile(join(root, 'tasks.jsonl'), JSON.stringify({ id: 'fixture', instruction: 'Return the fixture output', expected: 'PRIVATE', split: 'seed' }))
  const scorer = {
    version: 'fixture-v1', protocol: 'chat-completions@1', endpoint: 'https://localhost/v1/chat/completions',
    api_key_env: 'GEAR_SCORER_FIXTURE_API_KEY', model: 'fixture-model-v1', rubric: 'Pass exactly when correct.',
    randomness: { temperature: 0, seed: 7 }, artifacts: [],
    cost: { price_version: 'synthetic-prices', input_usd_per_million: 2, cached_input_usd_per_million: 1, output_usd_per_million: 4 },
    limits: { max_request_bytes: 65536, max_completion_tokens: 128, timeout_seconds: 15 },
  }
  const benchmark = await pythonJson(['benchmark', 'compile', '--root', root], {
    version: 1, source: 'tasks.jsonl', template: 'llm', scorer,
    fixtures: { fixture: [{ actual: 'correct', score: 1 }, { actual: 'wrong', score: 0 }, { actual: 'refuse', score: 0 }, { actual: 'lost', score: 0 }] },
  })
  assert.equal(benchmark.checks.verifier_fixtures, 'not_run')
  const plan = await pythonJson(['benchmark', 'probe-plan'], { benchmark, destination: join(root, 'probe'), task_id: 'fixture', base_image: image, scorer: true })
  // The fixture image provides a loopback-only HTTPS service. Production grader code is unchanged.
  const mock = join(plan.environment, 'mock'); await mkdir(mock)
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(mock, 'key.pem'), '-out', join(mock, 'cert.pem')])
  await writeFile(join(mock, 'sitecustomize.py'), `import json, ssl, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        if self.path != '/v1/chat/completions' or self.headers.get('Authorization') != 'Bearer fixture-key':
            self.send_error(401); return
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        actual=json.loads(payload['messages'][1]['content'])['actual']
        with Path('/logs/verifier/mock-requests.jsonl').open('a') as log:
            log.write(json.dumps({'actual':actual,'model':payload['model'],'seed':payload['seed']})+'\\n')
        if actual == 'lost':
            self.send_error(503); return
        message={'refusal':'fixture refusal' if actual == 'refuse' else None,
                 'content':json.dumps({'passed':actual == 'correct','reason':'synthetic decision'})}
        result={'id':'fixture-response','model':payload['model'],'system_fingerprint':'fp_fixture',
                'choices':[{'finish_reason':'stop','message':message}],
                'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120,
                         'prompt_tokens_details':{'cached_tokens':40}}}
        body=json.dumps(result).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
server=HTTPServer(('127.0.0.1',443),Handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/mock/cert.pem','/mock/key.pem')
server.socket=context.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
`)
  const dockerfile = join(plan.environment, 'Dockerfile')
  await writeFile(dockerfile, await readFile(dockerfile, 'utf8') + '\nCOPY mock/ /mock/\nENV PYTHONPATH=/mock SSL_CERT_FILE=/mock/cert.pem\n')
  const identity = await runner.build(plan, signal)
  process.env.GEAR_SCORER_FIXTURE_API_KEY = 'fixture-key'
  for (const fixture of plan.cases) {
    let failed = false
    try { await runner.verify(plan, fixture, identity, signal) } catch { failed = true }
    const result = await pythonJson(['benchmark', 'probe-result'], { directory: fixture.logs, expected_score: fixture.expected_score, usage_required: true })
    const requests = (await readFile(join(fixture.logs, 'mock-requests.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(requests.length, 1, 'No retries after a possibly charged response')
    assert.equal(failed, fixture.index >= 2)
    assert.equal(result.status, fixture.index < 2 ? 'passed' : 'scoring_failed')
    assert.equal(result.usage.request_attempts, 1)
    assert.equal(result.usage.model_requests, fixture.index === 3 ? null : 1)
    assert.equal(result.usage.tokens, fixture.index === 3 ? null : 120)
    assert.equal(result.usage.dollars, null)
    assert.equal(result.usage.estimated_dollars, fixture.index === 3 ? null : 0.00024)
    report.results.push(result)
  }
  report.passed = true
} finally {
  delete process.env.GEAR_SCORER_FIXTURE_API_KEY
  report.cleanup_required = await runner.dispose()
  report.passed &&= report.cleanup_required.length === 0
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: join(root, 'report.json'), passed: report.passed, synthetic_judge: true, external_model_calls: 0, cleanup_required: report.cleanup_required }))
  if (report.cleanup_required.length) throw new Error('Probe cleanup unconfirmed')
}
