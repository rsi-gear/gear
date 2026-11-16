import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pythonJson } from '../../src/application/python.js'
import { benchmarkSdkEnvironment } from '../../src/application/benchmark-sdk.js'
import { resourceSdkEnvironment } from '../../src/adapters/hitch/resource-sdk.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { ProjectConfig } from '../../src/domain/project.js'

let root: string
const bridge = fileURLToPath(new URL('../../python/gear/benchmark/resource_codec.cjs', import.meta.url))
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-resource-sdk-'))
  const python = join(root, 'python.cjs')
  await writeFile(python, `#!${process.execPath}
const fs=require('node:fs');const child=require('node:child_process').spawnSync(process.env.GEAR_NODE,[${JSON.stringify(bridge)}],{input:fs.readFileSync(0),env:process.env,encoding:'utf8'});process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exitCode=child.status;
`, { mode: 0o700 })
  vi.stubEnv('GEAR_PYTHON', python)
  vi.stubEnv('GEAR_PROFILE_ROOT', join(root, 'profiles'))
  vi.stubEnv('GEAR_HITCH_EXECUTABLE', '/missing/ambient/hitch')
  vi.stubEnv('GEAR_HITCH_CONTROLLER_RUNTIME_ID', canonicalDigest('wrong ambient runtime'))
  vi.stubEnv('PATH', root)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }) })
async function installation(name: string) {
  const directory = join(root, name), executable = join(directory, 'bin/hitch'), runtime = canonicalDigest(name)
  await mkdir(join(directory, 'bin'), { recursive: true })
  await writeFile(executable, '', { mode: 0o700 })
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ runtime_id: runtime }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'agent-hitch', type: 'module', exports: Object.fromEntries(['controller-runtime', 'resources', 'parameters'].map(n => ['./'+n, './sdk.mjs'])) }))
  await writeFile(join(directory, 'sdk.mjs'), `import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('./runtime.json',import.meta.url);export const observeControllerRuntime=async()=>JSON.parse(await readFile(file));
export async function verifyResourceDatasetSource(directory,manifest){await writeFile(new URL('./called',import.meta.url),'yes');if(manifest?.changeRuntime)await writeFile(file,JSON.stringify({runtime_id:'sha256:'+'9'.repeat(64)}));return {installation:${JSON.stringify(name)},directory};}
export const deriveResourceDatasetSource=verifyResourceDatasetSource;export const prepareParameterCandidateInputs=verifyResourceDatasetSource;
`)
  return { directory, executable, runtime }
}
it('uses each configured project profile without PATH Hitch and isolates concurrent Python calls', async () => {
  const a = await installation('a'), b = await installation('b')
  await mkdir(join(root, 'profiles'))
  for (const [name, selected] of [['one', a], ['two', b]] as const)
    await writeFile(join(root, 'profiles', name+'.json'), JSON.stringify({ kind: 'hitch', executable: selected.executable, root, harnessRef: 'pi@version:1.0.0', model: 'fixture', baseImage: 'image@'+canonicalDigest('image'), timeoutMs: 1000, passEnv: [] }))
  const envs = await Promise.all(['one', 'two'].map(name => benchmarkSdkEnvironment({ target: { profile: name } } as ProjectConfig)))
  const replies = await Promise.all(envs.map(env => pythonJson(['benchmark', 'fixture'], { operation: 'verify', directory: root }, undefined, env)))
  expect(replies).toEqual([{ installation: 'a', directory: root }, { installation: 'b', directory: root }])
  expect(process.env.GEAR_HITCH_EXECUTABLE).toBe('/missing/ambient/hitch')
  expect(process.env.GEAR_HITCH_CONTROLLER_RUNTIME_ID).toBe(canonicalDigest('wrong ambient runtime'))
})
it.each(['verify', 'derive', 'candidate-inputs'])('rejects a mismatched frozen runtime before resource %s', async operation => {
  const selected = await installation('selected')
  const run = spawnSync(process.execPath, [bridge], { encoding: 'utf8', input: JSON.stringify({ operation, directory: root }), env: { ...process.env, ...resourceSdkEnvironment({ executable: selected.executable, controllerRuntimeId: canonicalDigest('other') }) } })
  expect(run.status).toBe(1); expect(run.stderr).toContain('differs from the bound Hitch controller runtime')
  await expect(readFile(join(selected.directory, 'called'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects an SDK changed during its operation instead of sealing mixed runtime output', async () => {
  const selected = await installation('selected')
  const run = spawnSync(process.execPath, [bridge], { encoding: 'utf8', input: JSON.stringify({ operation: 'derive', directory: root, manifest: { changeRuntime: true } }), env: { ...process.env, ...resourceSdkEnvironment({ executable: selected.executable, controllerRuntimeId: selected.runtime }) } })
  expect(run.status).toBe(1); expect(run.stdout).toBe(''); expect(run.stderr).toContain('changed during the operation')
})

it('does not fall back to an ambient SDK when an existing selected profile is malformed', async () => {
  await mkdir(join(root, 'profiles'))
  await writeFile(join(root, 'profiles/broken.json'), '{malformed')
  await expect(benchmarkSdkEnvironment({ target: { profile: 'broken' } } as ProjectConfig)).rejects.toMatchObject({ code: 'profile-unavailable' })
  await expect(benchmarkSdkEnvironment({ target: { profile: 'not-created' } } as ProjectConfig)).resolves.toEqual({})
})
