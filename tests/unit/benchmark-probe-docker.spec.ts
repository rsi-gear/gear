import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DockerBenchmarkProbe, type BenchmarkProbePlan } from '../../src/adapters/hitch/benchmark-probe.js'

let root: string | undefined
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }) })
it('removes the running container after client cancellation and reports an image cleanup failure', async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-probe-docker-'))
  const bin = join(root, 'bin'), journal = join(root, 'commands.jsonl'), started = join(root, 'started')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') process.stdout.write('sha256:'+'1'.repeat(64));
if(args[0]==='image' && args[1]==='rm') { process.stderr.write('daemon unavailable');process.exit(1); }
if(args[0]==='run' && args.includes('/tests/test.sh')) { writeFileSync(${JSON.stringify(started)}, 'ready');setInterval(()=>{}, 1000); }
`, { mode: 0o700 })
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH)
  const runner = new DockerBenchmarkProbe(), abort = new AbortController()
  const plan = { environment: join(root, 'environment'), tests: join(root, 'tests') } as BenchmarkProbePlan
  const image = await runner.build(plan, abort.signal)
  const verifying = runner.verify(plan, { index: 0, workspace: root, logs: root, expected_score: 1 }, image, abort.signal)
  const rejected = expect(verifying).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'))
  abort.abort()
  await rejected
  expect(await runner.dispose()).toEqual([runner.tag])
  const commands: string[][] = (await readFile(journal, 'utf8')).trim().split('\n').map(value => JSON.parse(value))
  const verify = commands.find(args => args[0] === 'run' && args.includes('/tests/test.sh'))!
  expect(verify).toContain('--network=none')
  expect(verify).toContain('--security-opt=no-new-privileges')
  expect(verify).not.toContain('--env')
  const name = verify[verify.indexOf('--name') + 1]
  expect(commands.some(args => args[0] === 'rm' && args.includes(name!))).toBe(true)
})

it('passes only the declared judge credential name and enables networking only for paid fixtures', async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-probe-judge-'))
  const bin = join(root, 'bin'), journal = join(root, 'commands.jsonl')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') process.stdout.write('sha256:'+'1'.repeat(64));
`, { mode: 0o700 })
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH)
  vi.stubEnv('GEAR_SCORER_TEST_API_KEY', 'private-fixture-key')
  const runner = new DockerBenchmarkProbe(), signal = new AbortController().signal
  const plan = { environment: root, tests: root, usage_required: true, credential_env: ['GEAR_SCORER_TEST_API_KEY'], verifier_timeout_ms: 30000 } as BenchmarkProbePlan
  const image = await runner.build(plan, signal)
  await runner.verify(plan, { index: 0, workspace: root, logs: root, expected_score: 1 }, image, signal)
  await expect(runner.verify({ ...plan, credential_env: ['PATH'] }, { index: 0, workspace: root, logs: root, expected_score: 1 }, image, signal)).rejects.toMatchObject({ code: 'benchmark-scorer-credentials' })
  expect(await runner.dispose()).toEqual([])
  const content = await readFile(journal, 'utf8')
  expect(content).not.toContain('private-fixture-key')
  const runs: string[][] = content.trim().split('\n').map(value => JSON.parse(value)).filter(args => args[0] === 'run')
  expect(runs).toHaveLength(2)
  expect(runs[0]).toContain('--network=none')
  expect(runs[0]).not.toContain('--env')
  expect(runs[1]).toContain('--network=bridge')
  expect(runs[1]!.slice(runs[1]!.indexOf('--env'), runs[1]!.indexOf('--env') + 2)).toEqual(['--env', 'GEAR_SCORER_TEST_API_KEY'])
})

it('cleans the whole Compose project when startup is cancelled and removes only its built images', async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-probe-compose-'))
  const bin = join(root, 'bin'), journal = join(root, 'commands.jsonl'), started = join(root, 'started')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, JSON.stringify(args)+'\\n');
if(args[0]==='compose' && args.includes('up')) { writeFileSync(${JSON.stringify(started)}, 'ready');setInterval(()=>{}, 1000); }
`, { mode: 0o700 })
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH)
  const file = join(root, 'compose.json')
  const source = JSON.stringify({ services: { main: { build: { context: root } }, simulator: { image: 'shared@sha256:' + '1'.repeat(64) } } })
  await writeFile(file, source)
  const runner = new DockerBenchmarkProbe(), abort = new AbortController()
  const startedBuild = runner.build({ environment: root, compose: { file, services: ['main', 'simulator'] } } as BenchmarkProbePlan, abort.signal)
  const rejected = expect(startedBuild).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'))
  abort.abort()
  await rejected
  expect(await runner.dispose()).toEqual([])
  expect(await readFile(file, 'utf8')).toBe(source)
  const commands: string[][] = (await readFile(journal, 'utf8')).trim().split('\n').map(value => JSON.parse(value))
  const up = commands.find(args => args.includes('up'))!
  expect(up).toContain('--wait')
  const down = commands.find(args => args.includes('down'))!
  expect(down).toContain('--volumes')
  expect(down[down.indexOf('--project-name') + 1]).toBe(up[up.indexOf('--project-name') + 1])
  expect(commands.filter(args => args[0] === 'image' && args[1] === 'rm')).toEqual([['image', 'rm', runner.tag]])
})
