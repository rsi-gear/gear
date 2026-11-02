import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { fileLockHeld } from '../../src/adapters/storage/file-lock.js'
import { registerOperation, withJournal } from '../../src/adapters/codex/journal.js'
import type { CodexInput } from '../../src/adapters/codex/contracts.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { ProcessOperationProvider } from '../../src/adapters/process/operation-provider.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { describeCodex } from '../../src/adapters/codex/identity.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { TrajectoryStore } from '../../src/adapters/storage/trajectory.js'
import type { TrajectoryReference } from '../../src/domain/trajectory.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { ExperienceStore } from '../../src/adapters/storage/experience.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../../src/adapters/python/builtin-policy.js'
import type { ExperienceRecord, ExperienceContext } from '../../src/domain/experience.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import type { SearchView } from '../../src/domain/algorithm-wire.js'

const roots: string[] = [], operationRoots: string[] = []
const workerGroups = new Set<number>()
async function rememberWorker(directory: string) {
  try {
    const { pid } = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    workerGroups.add(pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  // A receipt precedes cleanup: keep operation and sandbox roots until their writer exits.
  for (const namespace of operationRoots.splice(0)) {
    const entries = await readdir(namespace, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    })
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      const directory = join(namespace, entry.name)
      await rememberWorker(directory)
      if ((await readdir(directory)).includes('execution.lock'))
        await expect.poll(() => fileLockHeld(join(directory, 'execution.lock')), { timeout: 8000 }).toBe(false)
    }
  }
  const groups = new Set(workerGroups); workerGroups.clear()
  if (groups.size)
    await expect.poll(async () => {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
      return stdout.split('\n').filter(line => {
        const [group, state] = line.trim().split(/\s+/u)
        return groups.has(Number(group)) && !state?.startsWith('Z')
      })
    }, { timeout: 8000 }).toEqual([])
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(mode = 'success', adapter: 'pi' | 'dsh' = 'pi', prepare = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-codex-test-')))
  roots.push(root)
  const privateRoot = join(root, 'private'),
    targets = join(privateRoot, 'targets'),
    directory = join(privateRoot, 'operations')
  await mkdir(join(targets, 'anchor'), { recursive: true })
  await mkdir(directory)
  operationRoots.push(directory)
  await writeFile(join(privateRoot, 'held-out.json'), 'HELD_OUT_PRIVATE_CANARY')
  const harness = adapter === 'pi' ? new PiHarnessAdapter() : new DshHarnessAdapter()
  await harness.prepare(join(targets, 'anchor'))
  const executable = join(root, 'fake-codex.mjs')
  const fakePython =
    process.platform === 'darwin'
      // Xcode-selected Python may live under /Applications, outside the sandbox.
      ? '/Library/Developer/CommandLineTools/usr/bin/python3'
      : '/usr/bin/python3'
  await writeFile(
    executable,
    `#!${fakePython}
import json,os,sys,time,subprocess
from pathlib import Path
if '--version' in sys.argv:
 print('codex-cli 0.145.0'); sys.exit(0)
args=sys.argv[1:]
for arg in ['exec','--ephemeral','--ignore-user-config','--ignore-rules','--strict-config','--json','--output-schema','--output-last-message']:
 assert arg in args, arg
for feature in ['apps','plugins']:
 assert args[args.index(feature)-1]=='--disable'
if sys.platform=='darwin':
 assert os.environ['CODEX_CA_CERTIFICATE']==os.environ['SSL_CERT_FILE']
 assert 'BEGIN CERTIFICATE' in Path(os.environ['CODEX_CA_CERTIFICATE']).read_text()
view=json.loads(Path('../input.json').read_text())
prompt=sys.stdin.read()
assert ('Do not edit the candidate.' if view['operation']['kind']=='diagnose_seed' else 'Change only the allowed mutation paths.') in prompt
assert len(view['tasks'])==1 and view['tasks'][0]['id']=='seed'
for path in [${JSON.stringify(join(privateRoot, 'held-out.json'))},${JSON.stringify(join(targets, 'anchor', adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'))}]:
 try:
  Path(path).read_text()
  raise AssertionError('PRIVATE_FILE_READABLE')
 except (PermissionError,FileNotFoundError): pass
assert 'GEAR_META_SECRET' not in os.environ
if ${JSON.stringify(mode)}=='proxy':
 import urllib.request,urllib.error
 assert 'PROXY_CREDENTIAL_CANARY' not in repr(dict(os.environ))
 assert urllib.request.urlopen('http://allowed.gear.test/probe',timeout=5).read()==b'upstream reached'
 try:
  urllib.request.urlopen('http://denied.gear.test/probe',timeout=5)
  raise AssertionError('DENIED_DOMAIN_REACHED')
 except urllib.error.HTTPError as error: assert error.code==403,error.code
if ${JSON.stringify(mode)}.startswith('connect-'):
 import socket,urllib.parse,base64
 proxy=urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
 tunnel=socket.create_connection((proxy.hostname,proxy.port),timeout=5)
 auth=''
 if proxy.username:
  auth='Proxy-Authorization: Basic '+base64.b64encode((urllib.parse.unquote(proxy.username)+':'+urllib.parse.unquote(proxy.password or '')).encode()).decode()+'\\r\\n'
 tunnel.sendall(('CONNECT allowed.gear.test:443 HTTP/1.1\\r\\nHost: allowed.gear.test:443\\r\\n'+auth+'\\r\\n').encode())
 header=b''
 while b'\\r\\n\\r\\n' not in header: header+=tunnel.recv(4096)
 assert b'200' in header,header
 tunnel.shutdown(socket.SHUT_WR)
 tunnel.close()
if 'experience' in view and ${JSON.stringify(mode)}!='historical-sdk':
 memory=view['experience']
 assert memory['cards'][0]['classification']['effect']=='regressed'
 query=subprocess.run(memory['reader']['argv'],input=json.dumps({'action':'query','query':{'effects':['regressed']}}),text=True,capture_output=True)
 assert query.returncode==0,query.stdout+query.stderr
 page=json.loads(query.stdout)
 assert page['total']==1 and page['snapshot_digest']==memory['snapshot_digest']
 detail=subprocess.run(memory['reader']['argv'],input=json.dumps({'action':'read','ref':page['items'][0]['card']['ref'],'view':'diff'}),text=True,capture_output=True)
 assert detail.returncode==0,detail.stdout+detail.stderr
 assert json.loads(detail.stdout)['items'][0]['patch']=='-before\\n+after\\n'
 if 'trajectory' in memory['reader']:
  def read_memory(body):
   return subprocess.run(memory['reader']['argv'],input=json.dumps(body),text=True,capture_output=True)
  ref=page['items'][0]['card']['ref']
  sources=read_memory({'action':'read','ref':ref,'view':'trajectory'})
  assert sources.returncode==0,sources.stdout+sources.stderr
  source=json.loads(sources.stdout)['items'][0]['ref']
  params={'action':'trajectory','ref':ref,'source_ref':source,'query':{'limit':1}}
  trace=read_memory(params)
  assert trace.returncode==0,trace.stdout+trace.stderr
  trace_page=json.loads(trace.stdout)
  assert trace_page['items'][0]['data']=='historical seed trace'
  assert trace_page['child_sessions']=='not-included'
  params['query']['cursor']=trace_page['next_cursor']
  second=read_memory(params)
  assert second.returncode==0,second.stdout+second.stderr
  assert json.loads(second.stdout)['items'][0]['seq']==1
  params['source_ref']='trajectory:'+'f'*64
  denied=read_memory(params)
  assert denied.returncode!=0 and 'trajectory-outside-snapshot' in denied.stdout+denied.stderr
  try:
   Path(${JSON.stringify(join(root, 'hitch-private/private.txt'))}).read_text()
   raise AssertionError('PROVIDER_PRIVATE_FILE_READABLE')
  except (PermissionError,FileNotFoundError): pass
output=Path(args[args.index('--output-last-message')+1])
schema=json.loads(Path(args[args.index('--output-schema')+1]).read_text())
assert ('data' if 'meta' in (view['operation'].get('payload') or {}) else 'clusters') in schema['required']
print(json.dumps({'type':'test.started','pid':os.getpid(),'cwd':os.getcwd()}),flush=True)
if ${JSON.stringify(mode)}=='slow': time.sleep(2.5)
if ${JSON.stringify(mode)} in ['hold','connect-cancel']: time.sleep(60)
if view['operation']['kind']=='diagnose_seed':
 try:
  Path(${JSON.stringify(adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md')}).write_text('unauthorized diagnosis edit')
  raise AssertionError('diagnosis could edit candidate')
 except OSError as error:
  import errno
  assert error.errno in (errno.EACCES,errno.EPERM,errno.EROFS),error
if view['operation']['kind']=='generate_candidate': Path(${JSON.stringify(adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md')}).write_text('Use the requested output format.')
if ${JSON.stringify(mode)}=='protected': Path('package.json').write_text('{}')
if ${JSON.stringify(mode)}=='invalid': output.write_text('not json')
elif ${JSON.stringify(mode)}=='invalid-result': output.write_text(json.dumps({'summary':'bad','declined':False,'hypotheses':[42],'clusters':[]}))
elif ${JSON.stringify(mode)}=='declined': output.write_text(json.dumps({'summary':'no change','declined':True,'hypotheses':[],'clusters':[]}))
elif ${JSON.stringify(mode)}.startswith('historical') and view['operation']['kind']=='diagnose_seed':
 custom=view['operation']['payload']['meta']
 key=custom['schema']['required'][0]
 assert schema['properties']['data']==custom['schema']
 choices=schema['properties']['data']['properties'][key]['enum']
 assert choices==(['anchor'] if ${JSON.stringify(mode)}=='historical-sdk' else ['anchor','older'])
 assert 'operation.payload.meta.prompt' in prompt and 'even when all tasks passed' in custom['prompt']
 output.write_text(json.dumps({'declined':False,'data':{key:'outside' if ${JSON.stringify(mode)}=='historical-invalid' else choices[-1]}}))
elif ${JSON.stringify(mode)}.startswith('historical'):
 assert schema['properties']['data']=={'type':'string'}
 output.write_text(json.dumps({'declined':False,'data':'Updated the selected candidate.'}))
else: output.write_text(json.dumps({'summary':'read isolation verified','declined':False,'hypotheses':['Respect output format'],'clusters':[{'task_ids':['seed'],'hypotheses':['Respect output format']}]}))
if ${JSON.stringify(mode)}=='partialusage': print(json.dumps({'type':'turn.completed','usage':{'output_tokens':3}}),flush=True)
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':12,'cached_input_tokens':3,'output_tokens':7}}),end='' if ${JSON.stringify(mode)}=='partialusage' else '\\n',flush=True)
if ${JSON.stringify(mode)} in ['partialfailed','connect-failure']:
 print(json.dumps({'type':'turn.started'}),flush=True)
 sys.exit(3)
`,
    { mode: 0o700 },
  )
  await chmod(executable, 0o700)
  const profile = {
    command: [process.execPath, resolve('assets/codex-meta-runner.mjs')],
    workingDirectory: root,
    configuration: { executable, model: 'fixture-model', allowedDomains: mode === 'proxy' || mode.startsWith('connect-') ? ['allowed.gear.test'] : [], timeoutMs: 12_000,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) },
    passEnv: mode === 'proxy' ? ['HTTP_PROXY', 'NO_PROXY'] : mode.startsWith('connect-') ? ['HTTPS_PROXY'] : [],
    timeoutMs: 20_000,
  }
  const context = {
    runId: 'run',
    targetAdapter: adapter,
    targets,
    directory,
    experiencePython: resolvePythonExecutable(),
    protectedPaths: [privateRoot],
    tasks: [{ id: 'seed', instruction: 'Produce the requested answer.', family: 'format' }],
  }
  const provider = await ProcessOperationProvider.connect(profile, context as unknown as Json)
  if (prepare) await provider.prepareAdmission()
  const request: OperationRequest = {
    operationId: canonicalDigest({ mode, adapter }),
    runId: 'run',
    generation: 1,
    operation: {
      kind: 'generate_candidate',
      candidate_id: 'candidate',
      parent_id: 'anchor',
      task_ids: ['seed'],
      scope: 'global',
      rationale: 'Improve format',
      payload: { hypothesis: 'Respect output format' },
    },
    partition: 'seed',
    repetitions: 0,
    slots: [],
    evidence: [
      {
        candidate_id: 'anchor',
        task_id: 'seed',
        repetition: 0,
        score: 0,
        status: 'valid',
        scope: 'global',
        feedback: 'wrong format',
      },
    ],
  }
  return {
    provider,
    request,
    root,
    privateRoot,
    directory: join(directory, request.operationId.slice(7)),
    targets,
    profile,
    context,
  }
}
const signal = () => new AbortController().signal
async function modelProcessIds(directory: string): Promise<number[]> {
  // Linux PID namespaces report a different PID inside the sandbox. Observe
  // the uniquely named fixture from the host, where cancellation is asserted.
  const executable = resolve(directory, '../../..', 'fake-codex.mjs')
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=', '-o', 'args='])
  return stdout.split('\n').filter(line => line.includes(executable)).map(line => Number(line.trim().split(/\s+/u)[0]))
}
async function untilStarted(directory: string) {
  for (let index = 0; index < 120; index++) {
    try {
      if ((await readFile(join(directory, 'events.jsonl'), 'utf8')).includes('test.started')) {
        // Some cases deliberately remove started.json after this point.
        await rememberWorker(directory)
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('fake Codex did not start')
}
describe('formal Codex operation runner', () => {
  it.each([
    ['base_candidate_id', false], ['another_algorithm_field', false], ['base_candidate_id', true],
  ] as const)('Python alone defines and validates Meta field %s (invalid=%s)', async (resultKey, invalid) => {
    const f = await fixture(invalid ? 'historical-invalid' : 'historical')
    await new PiHarnessAdapter().prepare(join(f.targets, 'older'))
    const source = join(f.root, 'source'), scratch = join(f.root, 'scratch')
    await mkdir(scratch)
    const identity = await freezeAlgorithmSource(source, [{ path: 'pr_cases.py', source: resolve('tests/fixtures/python-algorithm-boundaries.py') }])
    const worker = new PythonAlgorithmWorker({ python: resolvePythonExecutable(), sourceRoot: source, scratch, implementationIdentity: identity,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
    const view: SearchView = { run_id: 'run', step_id: 0, seed: 'fixed', anchor_id: 'anchor',
      candidates: ['anchor', 'older'].map(id => ({ id, digest: canonicalDigest(id), parent_id: null })),
      tasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }],
      evidence: ['anchor', 'older'].map(candidate_id => ({ candidate_id, task_id: 'seed', repetition: 0, score: 1, status: 'valid', scope: 'global', feedback: 'passed' })),
      completed: [], budget: { rounds: 1, repetitions: 1, candidates_remaining: 1, evaluations_remaining: 2 } }
    const algorithm = { name: 'pr_cases:HistoricalBase', options: { result_key: resultKey } }
    try {
      await worker.start(signal())
      const diagnosis = await worker.step(view, { version: 1, data: {} }, algorithm, signal())
      const receipt = await f.provider.submit({ ...f.request, operation: diagnosis.operations[0]!, evidence: view.evidence }, signal())
      expect(receipt.result.status).toBe('complete')
      view.completed.push(receipt.result); view.step_id++
      if (invalid) {
        // The model's schema is guidance, not the algorithm's semantic validation.
        const rejected = await worker.step(view, diagnosis.state, algorithm, signal())
        expect(rejected.state.data.rejected).toBe('historical base not offered')
        expect(rejected.operations.map(operation => operation.kind)).toEqual(['stop'])
        expect(receipt.candidate).toBeNull()
        return
      }
      const generation = await worker.step(view, diagnosis.state, algorithm, signal())
      expect(generation.operations[0]).toMatchObject({ kind: 'generate_candidate', parent_id: 'older' })
      const generated = await f.provider.submit({ ...f.request, operationId: canonicalDigest('historical-generation'), operation: generation.operations[0]! }, signal())
      expect(generated.result.status).toBe('complete')
      expect(generated.candidate).toMatchObject({ id: 'new', parent_id: 'older' })
      expect(generated.result.data).toEqual({ declined: false, data: 'Updated the selected candidate.' })
    } finally { await worker.dispose() }
  }, 30_000)

  it('public Python SDK freezes one external algorithm file, its configuration and recovery', async () => {
    const f = await fixture('historical-sdk')
    const profiles = join(f.root, 'profiles'), project = join(f.root, 'sdk-project')
    await mkdir(profiles)
    vi.stubEnv('GEAR_PROFILE_ROOT', profiles)
    const python = resolvePythonExecutable()
    // Persist the evaluation receipt, then lose its reply to require a fresh SDK resume.
    const targetProvider = join(f.root, 'target-provider.mjs')
    await writeFile(targetProvider, (await readFile(resolve('tests/fixtures/project-provider.mjs'), 'utf8')).replace(
      'process.stdout.write(JSON.stringify(result))',
      "if (action === 'submit' && request.operation.kind === 'evaluate_seed' && request.operation.candidate_id !== 'anchor') throw new Error('lost SDK evaluation reply'); process.stdout.write(JSON.stringify(result))"))
    await writeFile(join(profiles, 'sdk-target.json'), JSON.stringify({ command: [process.execPath, targetProvider],
      workingDirectory: f.root, passEnv: ['PYTHONPATH'], timeoutMs: 30_000,
      configuration: { python, receipts: join(f.root, 'target-receipts') } }))
    await writeFile(join(profiles, 'sdk-meta.json'), JSON.stringify(f.profile))
    await initProject(project, { adapter: 'pi', template: 'text', targetProfile: 'sdk-target', metaProfile: 'sdk-meta' })
    await writeFile(join(project, 'tasks.csv'), 'id,instruction,expected,family,split\nseed,Produce the requested answer.,42,format,seed\nheld-out,Private task.,43,private-family,held_out\n')
    if (process.env.GEAR_TEST_LINUX_ISOLATION)
      await writeFile(join(project, 'gear.yaml'), await readFile(join(project, 'gear.yaml'), 'utf8') + `\nsandbox: {linux_isolation: ${process.env.GEAR_TEST_LINUX_ISOLATION}}\n`)
    const ownFile = join(project, 'own_algorithm.py')
    await writeFile(ownFile, await readFile(resolve('tests/fixtures/python-algorithm-boundaries.py')))
    const sdk = (code: string) => promisify(execFile)(python, ['-c', code], { cwd: project, timeout: 60_000,
      env: { ...process.env, PYTHONPATH: resolve('python'), GEAR_PYTHON: python,
        GEAR_COMMAND: JSON.stringify([process.execPath, resolve('lib/cli.js')]) } })
    const failed = await sdk("from gear import Project; from own_algorithm import SDKExample; Project.open().refine(algorithm=SDKExample(result_key='sdk_selected'), rounds=1)").then(() => null, error => error)
    expect(failed?.stderr).toMatch(/lost SDK evaluation reply|process-operation-failed/)
    const runs = join(project, '.gear/runs'), [id] = await readdir(runs)
    expect(id).toBeTruthy()
    const runRoot = join(runs, id!), journalPath = join(runRoot, 'journal.json')
    const before = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(before.status).toBe('needs_recovery')
    expect(before.spec.algorithm).toEqual({ name: 'own_algorithm:SDKExample', options: { result_key: 'sdk_selected' } })
    expect(before.operations.map((entry: { request: OperationRequest }) => entry.request.operation.kind)).toEqual(['evaluate_seed', 'diagnose_seed', 'generate_candidate', 'evaluate_seed'])
    expect(before.operations[1].receipt.result.data.data).toEqual({ sdk_selected: 'anchor' })
    expect(before.operations[2].receipt.result.candidate_change.omitted_patches).toBe(0)
    expect(before.operations[3].status).toBe('submitted')
    expect(await readFile(join(runRoot, 'algorithm/own_algorithm.py'), 'utf8')).toBe(await readFile(ownFile, 'utf8'))
    await writeFile(ownFile, "raise RuntimeError('mutable author file must not be reloaded')\n")
    await sdk(`from gear import Project; Project.open().resume(${JSON.stringify(id)})`)
    const after = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(after.status).toBe('completed')
    expect(after.operations).toHaveLength(4)
    expect(after.operations[1].receipt).toEqual(before.operations[1].receipt)
    expect(after.operations[2].receipt).toEqual(before.operations[2].receipt)
    expect(after.decisions.at(-1).decision.operations[0].kind).toBe('stop')
  }, 90_000)

  it('chains explicit upstream proxies without exposing credentials or bypassing domain restrictions', async () => {
    const requests: string[] = []
    const authorization: Array<string | undefined> = []
    const proxy = createServer((request, response) => {
      requests.push(request.url ?? '')
      authorization.push(request.headers['proxy-authorization'])
      response.end('upstream reached')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const address = proxy.address() as { port: number }
      vi.stubEnv('HTTP_PROXY', `http://fixture:PROXY_CREDENTIAL_CANARY@127.0.0.1:${address.port}`)
      vi.stubEnv('NO_PROXY', 'denied.gear.test')
      const f = await fixture('proxy')
      const receipt = await f.provider.submit(f.request, signal())
      expect(receipt.result.status, await readFile(join(f.directory, 'stderr.log'), 'utf8')).toBe('complete')
      expect(requests).toEqual(['http://allowed.gear.test/probe'])
      expect(authorization).toEqual([`Basic ${Buffer.from('fixture:PROXY_CREDENTIAL_CANARY').toString('base64')}`])
      expect(await readFile(join(f.directory, 'job.json'), 'utf8')).not.toContain('PROXY_CREDENTIAL_CANARY')
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    }
  })
  it('binds the optional code-mode companion to the runtime identity', async () => {
    const { profile, root } = await fixture()
    const before = await describeCodex(profile.configuration)
    const companion = join(root, 'codex-code-mode-host')
    await writeFile(companion, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const present = await describeCodex(profile.configuration)
    expect(present.codeModeHost).toBe(companion)
    expect(present.identity).not.toBe(before.identity)
    await writeFile(companion, '#!/bin/sh\nexit 1\n')
    expect((await describeCodex(profile.configuration)).identity).not.toBe(present.identity)
  })
  for (const withTrajectory of [false, true])
  it(`queries and reads frozen seed experiences${withTrajectory ? ' and trajectory pages' : ''} inside the actual Meta sandbox`, async () => {
    const { provider: initialProvider, request, context, root, profile } = await fixture('success', 'pi', false)
    let provider = initialProvider
    const trajectory_refs: TrajectoryReference[] = []
    if (withTrajectory) {
      const hitchRoot = join(root, 'hitch-private'), run = 'run_' + 'a'.repeat(32), executable = join(root, 'hitch.mjs')
      await mkdir(hitchRoot)
      await writeFile(join(hitchRoot, 'private.txt'), 'PROVIDER_PRIVATE_CANARY')
      await writeFile(join(hitchRoot, run + '.json'), JSON.stringify([{ seq: 0, type: 'assistant/message', data: 'historical seed trace' }, { seq: 1, type: 'tool/result', data: 'result' }]))
      await writeFile(executable, `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`, { mode: 0o700 })
      // The detached operation runs the installed JS adapter. Bind that actual implementation.
      const { HitchArtifactReader } = await import(new URL('../../lib/adapters/hitch/trajectory.js', import.meta.url).href)
      const reader = new HitchArtifactReader(executable, hitchRoot)
      const artifact = await reader.capture(run, 'seed', 0, signal())
      expect(artifact.status).toBe('available')
      const source = await new TrajectoryStore(join(context.targets, '../trajectory-sources')).save({ version: 1, run_id: 'run', candidate_id: 'anchor', operation_id: canonicalDigest('evaluation'), origin_run_id: 'run', origin_candidate_id: 'anchor', receipt_digest: canonicalDigest('receipt'), reader_identity: canonicalDigest(reader.descriptor), partition: 'seed', artifact })
      trajectory_refs.push({ ref: 'trajectory:' + source.digest.slice(7), candidate_id: 'anchor', task_id: 'seed', repetition: 0, status: artifact.status, content_digest: artifact.content_digest, reason: null })
      provider = await ProcessOperationProvider.connect(profile, { ...context, artifactReader: reader.descriptor, experiencePython: resolvePythonExecutable() } as unknown as Json)
    }
    await provider.prepareAdmission()
    const record = builtinPolicy<ExperienceRecord>('experience_record', {
      source: { run_id: 'run' }, candidate: { id: 'anchor', digest: canonicalDigest('anchor'), parent_id: 'older' },
      parent: { id: 'older', digest: canonicalDigest('older'), parent_id: null }, task_ids: ['seed'], repetitions: 1,
      objective: null, evidence: ['older', 'anchor'].map((candidate_id, index) => ({ candidate_id, task_id: 'seed', repetition: 0, status: 'valid', score: index === 0 ? 1 : 0 })),
      trajectory_refs,
      proposal: { rationale: 'format', hypothesis: 'format', semantic_targets: [] },
      change: { files: [{ path: 'AGENTS.md', patch: '-before\n+after\n' }] },
    })
    const body = { version: 2 as const, run_id: 'run', source_archive_digest: canonicalDigest('archive'), implementation_identity: builtinPolicyImplementationDigest, records: [record] }
    const snapshot = { ...body, digest: canonicalDigest(body) }
    await new ExperienceStore(join(context.targets, '../experience')).save(snapshot)
    const selected = builtinPolicy<Omit<ExperienceContext, 'digest' | 'implementation_identity'>>('experience_context', { records: [record], snapshot_digest: snapshot.digest, parent_id: 'anchor', evidence: request.evidence })
    const memory = { ...selected, implementation_identity: snapshot.implementation_identity }
    request.experience = { ...memory, digest: canonicalDigest(memory) }
    request.operationId = canonicalDigest([request.operationId, request.experience.digest])
    const receipt = await provider.submit(request, signal())
    const diagnostic = await readFile(join(context.directory, request.operationId.slice(7), 'stderr.log'), 'utf8').catch(() => '')
    expect(receipt.result.status, JSON.stringify(receipt) + diagnostic).toBe('complete')
    expect(receipt.result.data).toMatchObject({ summary: 'read isolation verified' })
  }, 30_000)
  it('keeps a missing turn counter unknown and reads the final event without a trailing newline', async () => {
    const { provider, request } = await fixture('partialusage')
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.status).toBe('complete')
    expect(receipt.usage).toEqual({ input_tokens: null, cached_input_tokens: null, output_tokens: 10,
      tokens: null, model_requests: null, dollars: null })
  }, 30_000)
  it('does not report completed-turn usage as the total after a later turn fails', async () => {
    const { provider, request } = await fixture('partialfailed')
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.status).toBe('failed')
    expect(receipt.candidate).toBeNull()
    expect(Object.values(receipt.usage)).toEqual([null, null, null, null, null, null])
  }, 30_000)
  for (const adapter of ['pi', 'dsh'] as const)
    it(`isolates seed/candidate and persists one ${adapter} generation`, async () => {
      const { provider, request, targets, directory } = await fixture('success', adapter)
      const [first, duplicate] = await Promise.all([
        provider.submit(request, signal()),
        provider.submit(request, signal()),
      ])
      expect(
        first.result.status,
        await readFile(join(directory, 'stderr.log'), 'utf8').catch(() => 'no native diagnostics'),
      ).toBe('complete')
      expect(first.result.data).toMatchObject({ summary: 'read isolation verified' })
      expect(duplicate).toEqual(first)
      expect(first.candidate).toMatchObject({ id: 'candidate', parent_id: 'anchor' })
      expect(first.usage).toEqual({
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
        tokens: 19,
        model_requests: null,
        dollars: null,
      })
      expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(
        1,
      )
      expect(await provider.inspect(request, signal())).toEqual({ state: 'complete', receipt: first })
      expect(
        await readFile(join(targets, 'anchor', adapter === 'pi' ? 'AGENTS.md' : 'prompts/system.md'), 'utf8'),
      ).toContain('Follow the task instruction')
      await expect(provider.submit({ ...request, generation: 2 }, signal())).rejects.toThrow(
        'codex-operation-conflict',
      )
    }, 30_000)
  it('recovers a durable receipt after the waiting caller is interrupted', async () => {
    const { provider, request, directory } = await fixture('slow')
    const controller = new AbortController()
    const waiting = provider.submit(request, controller.signal).catch((error) => error)
    await untilStarted(directory)
    controller.abort()
    expect(await waiting).toBeInstanceOf(Error)
    expect((await provider.inspect(request, signal())).state).toBe('running')
    await delay(2700)
    const result = await provider.inspect(request, signal())
    expect(result.state).toBe('complete')
    if (result.state === 'complete') expect(result.receipt.result.status).toBe('complete')
    expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
  }, 30_000)
  it('cancels the owned process and persists its failed receipt', async () => {
    const { provider, request, directory } = await fixture('hold')
    const waiting = provider.submit(request, signal())
    await untilStarted(directory)
    await provider.cancel(request)
    expect((await provider.inspect(request, signal())).state).toBe('complete')
    await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
    const receipt = await waiting
    expect(receipt.result.status).toBe('failed')
    expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
    expect(receipt.candidate).toBeNull()
    expect(await provider.submit(request, signal())).toEqual(receipt)
  }, 30_000)
  for (const mode of ['invalid', 'invalid-result', 'declined', 'protected'])
    it(`rejects ${mode} model output without publishing a candidate`, async () => {
      const { provider, request, targets } = await fixture(mode)
      const receipt = await provider.submit(request, signal())
      expect(receipt.result.status).toBe('failed')
      expect(receipt.candidate).toBeNull()
      if (mode.startsWith('invalid')) expect(receipt.result.data).toEqual({ error: 'codex-output-invalid' })
      if (mode === 'declined') expect(receipt.result.data).toMatchObject({ declined: true })
      await expect(readFile(join(targets, 'candidate/AGENTS.md'))).rejects.toThrow()
    }, 30_000)
  it('rejects held-out requests before model submission', async () => {
    const { provider, request } = await fixture()
    await expect(provider.submit({ ...request, partition: 'held_out' }, signal())).rejects.toThrow(
      'codex-request-invalid',
    )
    await expect(
      provider.submit({ ...request, evidence: [{ ...request.evidence[0]!, task_id: 'held-out' }] }, signal()),
    ).rejects.toThrow('codex-evidence-invalid')
    expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  })
  it('diagnoses using a read-only candidate and returns no candidate publication', async () => {
    const { provider, request } = await fixture()
    request.operation = {
      ...request.operation,
      kind: 'diagnose_seed',
      candidate_id: 'anchor',
      parent_id: null,
    }
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.status).toBe('complete')
    expect(receipt.candidate).toBeNull()
    expect(receipt.result.data).toMatchObject({ hypotheses: ['Respect output format'] })
  })
  it('fences cancellation before submission without starting a model', async () => {
    const { provider, request, directory } = await fixture()
    await provider.cancel(request)
    const receipt = await provider.submit(request, signal())
    expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
    await expect(readFile(join(directory, 'events.jsonl'))).rejects.toThrow()
  })
  it('rejects a changed executable after handshake', async () => {
    const { provider, request, profile } = await fixture()
    await writeFile(
      profile.configuration.executable,
      (await readFile(profile.configuration.executable, 'utf8')) + '\n# changed implementation\n',
    )
    await expect(provider.submit(request, signal())).rejects.toThrow('codex-identity-changed')
    expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  })
  it('leaves a killed worker unknown, terminates its model child and never resubmits', async () => {
    const { provider, request, directory } = await fixture('hold')
    const waiting = provider.submit(request, signal()).catch((error) => error)
    await untilStarted(directory)
    const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
    const event = JSON.parse((await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n')[0]!) as {
      pid: number
      cwd: string
    }
    process.kill(started.pid, 'SIGKILL')
    expect(await waiting).toBeInstanceOf(Error)
    expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
    await expect(provider.cancel(request)).rejects.toThrow('codex-cancellation-unconfirmed')
    await expect(provider.submit(request, signal())).rejects.toThrow('codex-result-unknown')
    await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
    expect(
      await readFile(join(event.cwd, 'AGENTS.md')).then(
        () => true,
        () => false,
      ),
      await readFile(join(directory, 'stderr.log'), 'utf8'),
    ).toBe(false)
    expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
  }, 30_000)
})

it('stops an owned Codex process through the admission snapshot after the model executable disappears', async () => {
  const { provider, request, directory, profile } = await fixture('hold')
  const waiting = provider.submit(request, signal())
  await untilStarted(directory)
  await rm(profile.configuration.executable)
  const cancel = await configuredCancellation(provider.cancellation)
  await cancel.cancel(request)
  const receipt = await waiting
  expect(receipt.result.data).toEqual({ error: 'codex-cancelled' })
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
  expect((await provider.inspect(request, signal())).state).toBe('complete')
}, 30_000)

for (const lost of ['job', 'operation', 'namespace', 'journal'] as const)
it(`does not confirm cancellation or replay when the ${lost} state disappears`, async () => {
  const { provider, request, directory, context } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  const path = lost === 'job' ? join(directory, 'job.json') : lost === 'operation' ? directory : lost === 'journal' ? join(context.directory, 'operations.json') : context.directory
  const backup = `${context.directory}-lost-${lost}`
  process.kill(worker.pid, 'SIGSTOP')
  await rename(path, backup)
  try {
    const cancel = await configuredCancellation(provider.cancellation)
    await expect(cancel.cancel(request)).rejects.toThrow()
    expect(await modelProcessIds(directory)).not.toEqual([])
    expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
    await expect(provider.submit(request, signal())).rejects.toThrow()
  } finally {
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    process.kill(worker.pid, 'SIGCONT')
    await provider.cancel(request)
    await waiting
  }
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
}, 30_000)

it('keeps describe read-only and never initializes missing operation state on reconnect', async () => {
  const { provider, request, context, profile } = await fixture('success', 'pi', false)
  const journal = join(context.directory, 'operations.json')
  await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
  await expect(provider.cancel(request)).rejects.toThrow('codex-state-unavailable')
  await provider.prepareAdmission()
  expect(await provider.inspect(request, signal())).toEqual({ state: 'not_submitted' })
  await rm(journal)
  const restored = await ProcessOperationProvider.connect(profile, context as unknown as Json)
  expect(await restored.inspect(request, signal())).toEqual({ state: 'unknown' })
  await expect(restored.submit(request, signal())).rejects.toThrow('codex-state-unavailable')
  await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('requires a stopped receipt even if started.json disappears, then confirms actual termination', async () => {
  const { provider, request, directory } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  process.kill(worker.pid, 'SIGSTOP')
  try {
    await rm(join(directory, 'started.json'))
    await expect(provider.cancel(request)).rejects.toThrow('codex-cancellation-unconfirmed')
    expect(await modelProcessIds(directory)).not.toEqual([])
  } finally {
    process.kill(worker.pid, 'SIGCONT')
    await provider.cancel(request)
    await waiting
  }
  await expect.poll(() => modelProcessIds(directory), { timeout: 5000 }).toEqual([])
  expect((await provider.inspect(request, signal())).state).toBe('complete')
}, 30_000)
it('does not restart a killed worker even if its started marker is also lost', async () => {
  const { provider, request, directory } = await fixture('hold')
  const waiting = provider.submit(request, signal()).catch(error => error)
  await untilStarted(directory)
  const worker = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number }
  process.kill(worker.pid, 'SIGKILL')
  expect(await waiting).toBeInstanceOf(Error)
  await rm(join(directory, 'started.json'))
  await promisify(execFile)(process.execPath, [resolve('assets/codex-meta-runner.mjs'), '--worker', directory])
  expect(await provider.inspect(request, signal())).toEqual({ state: 'unknown' })
  expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)


for (const mode of ['connect-success', 'connect-failure', 'connect-cancel'])
it(`publishes the ${mode} result and releases its worker/lock despite a half-closed CONNECT tunnel`, async () => {
  const sockets = new Set<Socket>(), requests: string[] = []
  const upstream = createNetServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let header = ''
    socket.on('data', chunk => {
      header += chunk.toString()
      if (!header.includes('\r\n\r\n')) return
      requests.push(header.split('\r\n')[0]!)
      socket.removeAllListeners('data')
      socket.resume()
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    // Keep the response half open after FIN. This is the dependency reset deadlock.
    socket.on('end', () => {})
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${(upstream.address() as { port: number }).port}`)
    const f = await fixture(mode)
    const waiting = f.provider.submit(f.request, signal())
    await untilStarted(f.directory)
    if (mode === 'connect-cancel') await f.provider.cancel(f.request)
    const receipt = await waiting
    expect(receipt.result.status, await readFile(join(f.directory, 'stderr.log'), 'utf8')).toBe(mode === 'connect-success' ? 'complete' : 'failed')
    expect(receipt.candidate === null).toBe(mode !== 'connect-success')
    expect(requests).toEqual(['CONNECT allowed.gear.test:443 HTTP/1.1'])
    const started = JSON.parse(await readFile(join(f.directory, 'started.json'), 'utf8')) as { pid: number }
    await expect.poll(() => readFile(join(f.directory, 'cleanup.json'), 'utf8').then(JSON.parse).catch(() => null), { timeout: 5000 }).toMatchObject({ status: 'fallback-required', model_stopped: true, stages: { credentials: 'complete', sandbox: 'timed-out', root: 'complete' } })
    await expect.poll(async () => {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
      return stdout.split('\n').some(line => { const [group, state] = line.trim().split(/\s+/u); return Number(group) === started.pid && !state?.startsWith('Z') })
    }, { timeout: 5000 }).toBe(false)
    expect(await fileLockHeld(join(f.directory, 'execution.lock'))).toBe(false)
    const event = JSON.parse((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).split('\n')[0]!) as { cwd: string }
    await expect(readFile(join(event.cwd, '../home/.codex/auth.json'))).rejects.toThrow()
    await expect(readFile(join(event.cwd, 'AGENTS.md'))).rejects.toThrow()
    // The deliberately half-open test peer retains its own write half even
    // after the worker's FDs are gone. Finish its FIN handshake only now.
    expect([...sockets].every(socket => socket.readableEnded)).toBe(true)
    for (const socket of sockets) socket.end('closed-endpoint-probe')
    await expect.poll(() => sockets.size, { timeout: 3000 }).toBe(0)
    expect(await f.provider.submit(f.request, signal())).toEqual(receipt)
    expect((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
}, 30_000)

it('keeps a signal-killed guard without its private acknowledgment unknown and never repeats its call', async () => {
  const f = await fixture('hold')
  const waiting = f.provider.submit(f.request, signal()).catch(error => error)
  await untilStarted(f.directory)
  const { pid: worker } = JSON.parse(await readFile(join(f.directory, 'started.json'), 'utf8')) as { pid: number }
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='])
  const rows = stdout.split('\n').map(line => line.trim().split(/\s+/u))
  const guard = rows.find(row => Number(row[1]) === worker && row.slice(2).join(' ').includes('/assets/codex-process-guard.py'))
  expect(guard).toBeDefined()
  const leader = rows.find(row => Number(row[1]) === Number(guard![0]))
  expect(leader).toBeDefined()
  const event = JSON.parse((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).split('\n')[0]!) as { cwd: string }
  roots.push(resolve(event.cwd, '..'))
  // Both exact PIDs belong to this isolated sleeping fixture; no existing host
  // process is signalled. Stop the orphan fixture model after removing its guard.
  process.kill(Number(guard![0]), 'SIGKILL')
  try { process.kill(-Number(leader![0]), 'SIGKILL') }
  catch (error) {
    // Linux may already reap the child group when its guard dies.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  expect(await waiting).toBeInstanceOf(Error)
  expect(await f.provider.inspect(f.request, signal())).toEqual({ state: 'unknown' })
  await expect(readFile(join(f.directory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(join(f.directory, 'cleanup.json'), 'utf8'))).toMatchObject({ model_stopped: false, stages: { root: 'unconfirmed', credentials: 'unconfirmed' } })
  expect(await readFile(join(event.cwd, 'AGENTS.md'), 'utf8')).toContain('Follow the task instruction')
  await expect(f.provider.submit(f.request, signal())).rejects.toThrow('codex-result-unknown')
  expect((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)

it('refuses a real nonleader worker before writing started or spawning a model', async () => {
  const f = await fixture()
  const input: CodexInput = { version: 1, action: 'submit', configuration: f.profile.configuration, context: f.context, request: f.request, implementationIdentity: f.provider.implementationIdentity }
  const digest = canonicalDigest({ request: f.request, configuration: input.configuration, context: input.context, implementationIdentity: input.implementationIdentity })
  await withJournal(input, journal => registerOperation(input, journal, { digest, state: 'admitted' }))
  await mkdir(f.directory)
  await writeFile(join(f.directory, 'job.json'), JSON.stringify({ version: 1, input, digest, identity: input.implementationIdentity }))
  await expect(promisify(execFile)(process.execPath, [resolve('assets/codex-meta-runner.mjs'), '--worker', f.directory])).rejects.toMatchObject({ stderr: expect.stringContaining('codex-worker-group-invalid') })
  await expect(readFile(join(f.directory, 'started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.directory, 'events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fileLockHeld(join(f.directory, 'execution.lock'))).toBe(false)
  expect((await modelProcessIds(f.directory))).toEqual([])
})


it('cleans up and releases its lock after receipt publication fails without replaying the model', async () => {
  const f = await fixture('slow')
  const waiting = f.provider.submit(f.request, signal()).catch(error => error)
  await untilStarted(f.directory)
  // A private test-only directory conflicts with atomic receipt publication.
  // Create it after start so it cannot bypass the worker's execution admission.
  await mkdir(join(f.directory, 'receipt.json'))
  expect(await waiting).toBeInstanceOf(Error)
  await expect.poll(() => readFile(join(f.directory, 'cleanup.json'), 'utf8').then(JSON.parse).catch(() => null), { timeout: 8000 }).toMatchObject({ model_stopped: true, stages: { credentials: 'complete', gateway: 'complete', sandbox: 'complete', root: 'complete' } })
  await expect.poll(() => fileLockHeld(join(f.directory, 'execution.lock')), { timeout: 3000 }).toBe(false)
  const { pid } = JSON.parse(await readFile(join(f.directory, 'started.json'), 'utf8')) as { pid: number }
  await expect.poll(async () => {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='])
    return stdout.split('\n').some(line => { const [group, state] = line.trim().split(/\s+/u); return Number(group) === pid && !state?.startsWith('Z') })
  }, { timeout: 3000 }).toBe(false)
  const event = JSON.parse((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).split('\n')[0]!) as { cwd: string }
  await expect(readFile(join(event.cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Remove only the artificial conflict. Original admission/started state stays
  // intact and still forbids a second model execution without a durable result.
  await rm(join(f.directory, 'receipt.json'), { recursive: true })
  expect(await f.provider.inspect(f.request, signal())).toEqual({ state: 'unknown' })
  await expect(f.provider.submit(f.request, signal())).rejects.toThrow('codex-result-unknown')
  expect((await readFile(join(f.directory, 'events.jsonl'), 'utf8')).match(/test.started/gu)).toHaveLength(1)
}, 30_000)
