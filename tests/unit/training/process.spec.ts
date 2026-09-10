import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonProcess } from '../../../src/training/process.js'
import { SlimeModelTrainer } from '../../../src/training/slime.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { ModelTrainingCoordinator } from '../../../src/training/coordinator.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'

describe('packaged training subprocess boundary', () => {
  const roots: string[] = []
  afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  it('passes multiline input as JSON stdin without invoking a shell', async () => {
    const input = { text: 'literal $HOME `not-a-command`\n中文', array: [0, false] }
    const result = await jsonProcess([process.execPath], ['-e', 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s))'], input)
    expect(result).toEqual(input)
  })
  it('reports structured failures and bounds a hung RPC', async () => {
    await expect(jsonProcess([process.execPath], ['-e', 'console.log(JSON.stringify({error:{code:"fenced",message:"old policy"}}));process.exit(1)'])).rejects.toMatchObject({ code: 'fenced' })
    await expect(jsonProcess([process.execPath], ['-e', 'setInterval(()=>{},1000)'], {}, 50)).rejects.toMatchObject({ code: 'process-timeout' })
  })
  it('reports empty responses with exit metadata and keeps bounded stderr private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-process-diagnostics-')); roots.push(root)
    vi.stubEnv('GEAR_TRAINING_PROCESS_DIAGNOSTICS', root)
    const secret = 'private-child-error'
    const error = await jsonProcess([process.execPath], ['-e', `process.stderr.write('${secret}'+'.'.repeat(100000));process.exitCode=12`]).catch(e => e)
    if (!(error instanceof Error)) throw new Error('expected a subprocess failure')
    expect(error).toMatchObject({ code: 'process-failed' })
    expect(error.message).toContain('exit=12')
    expect(error.message).toContain('stdoutBytes=0')
    expect(error.message).not.toContain(secret)
    const files = await readdir(root); expect(files).toHaveLength(1)
    const path = join(root, files[0]!); expect((await stat(path)).mode & 0o777).toBe(0o600)
    const diagnostics = JSON.parse(await readFile(path, 'utf8'))
    expect(diagnostics.stderr).toHaveLength(65536)
    expect(diagnostics.stderr).toContain(secret)
    expect(diagnostics).not.toHaveProperty('argv')
    expect(diagnostics).not.toHaveProperty('stdin')
    await expect(jsonProcess([process.execPath], ['-e', ''])).rejects.toMatchObject({ code: 'invalid-process-json' })
  })
  it('real Python RPC refuses pending GPU locks without importing a fake optimizer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-training-rpc-')); roots.push(root)
    const store = new ModelTrainingStore(root)
    const spec = await fixture(store); spec.trainer.runtimeLock.validation = 'pending-gpu'; spec.trainer.runtimeLock.probeEvidenceRefs = []
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec); const run = await coordinator.admit(experiment.id)
    const configPath = join(root, 'job-config.json')
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, storeRoot: root, jobsRoot: join(root, 'jobs'), hitchRoot: join(root, 'hitch'),
      hitchPath: root, slimePath: root, megatronPath: root, hitchCommand: [join(root, 'not-installed')], gatewayBindHost: '127.0.0.1', gatewayAdvertisedHost: '127.0.0.1', episodeTimeoutSeconds: 60 }))
    const trainer = new SlimeModelTrainer({ python: ['env', `PYTHONPATH=${resolve('python')}`, 'python3'], configPath })
    const caps = await trainer.preflight(run.request)
    expect(caps.blockers).toContain('gpu-probes-pending')
    expect(caps.exactPolicyTokens).toBe(false)
    await expect(trainer.submit(run.request, run.idempotencyKey)).rejects.toMatchObject({ code: 'training-preflight-blocked' })
  })
})
