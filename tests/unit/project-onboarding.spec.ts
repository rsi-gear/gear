import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectController } from '../../src/application/project-controller.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { createProfile } from '../../src/application/profile-service.js'
import { defaultProfiles, processProfile, profile, saveProfile, selectDefaultProfile, validateProfile } from '../../src/application/profile-store.js'
import { initProject } from '../../src/application/init.js'
import { resolveProject } from '../../src/application/project-config.js'
import { doctor } from '../../src/application/doctor.js'
import { managedPythonRoot, setupPython } from '../../src/application/python.js'

vi.mock('../../src/sandbox.js', () => ({ acquireAirGappedSandbox: vi.fn(async () => ({ release: async () => {} })) }))
let root: string
const python = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-onboarding-'))
  vi.stubEnv('GEAR_PROFILE_ROOT', join(root, 'profiles'))
  vi.stubEnv('GEAR_HOME', join(root, 'managed'))
  vi.stubEnv('GEAR_PYTHON', python)
  vi.stubEnv('CODEX_API_KEY', '')
  vi.stubEnv('OPENAI_API_KEY', '')
})
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function executable(name: string, source: string) {
  const path = join(root, name)
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  return path
}
const image = `python@sha256:${'1'.repeat(64)}`
const processSettings = () => ({ command: [process.execPath, resolve('tests/fixtures/project-provider.mjs')], workingDirectory: root, passEnv: [], configuration: {}, timeoutMs: 30_000 })

it('creates default and configured preparation profiles through the public CLI', async () => {
  const binary = await executable('hitch-profile', '')
  for (const [name, flags, expected] of [
    ['defaults', [], { maxConcurrent: 4, preparationTimeoutMs: 1_800_000, setupTimeoutMs: 1_800_000 }],
    ['configured', ['--max-concurrent', '64', '--preparation-timeout-ms', '1200000', '--setup-timeout-ms', '0',
      '--agent-args-json', '["--patch","/opt/provider.json"]'],
      { maxConcurrent: 64, preparationTimeoutMs: 1_200_000, setupTimeoutMs: 0, agentArgs: ['--patch', '/opt/provider.json'] }],
  ] as const) {
    execFileSync(process.execPath, [resolve('lib/cli.js'), '--project', root, 'profile', 'create', name,
      '--kind', 'hitch', '--adapter', 'dsh', '--model', 'fixture-model', '--executable', binary,
      '--hitch-root', join(root, 'hitch-state'), '--image', image, ...flags, '--json'], { encoding: 'utf8' })
    expect(await profile(name)).toMatchObject(expected)
  }
})

async function codex(name = 'meta', authHome?: string, passEnv?: string[]) {
  const binary = await executable('codex', `
if (process.argv.includes('--version')) console.log('codex-cli 0.159.3');
else if (process.argv.slice(2).join(' ') === 'login status') {
  console.error('SECRET_LOGIN_VALUE');
  const fs = require('node:fs');
  process.exit(fs.existsSync(require('node:path').join(process.env.CODEX_HOME,'auth.json')) ? 0 : 1);
} else throw new Error('Doctor attempted a model call');`)
  await createProfile(name, { kind: 'codex', model: 'test-model', executable: binary, ...(authHome ? { authHome } : {}), ...(passEnv ? { passEnv } : {}) })
  return name
}
async function hitch() {
  const binary = await executable('hitch', `
const args=process.argv.slice(4);
if(args[0]==='eval'&&args[1]==='doctor') console.log(JSON.stringify({ready:true,checks:{harbor:{version:'0.21.0'}}}));
else { require('node:fs').mkdirSync(process.argv[3], {recursive:true});
 import(${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)}).then(m=>m.runOrderedHitchFixture('sha256:'+'2'.repeat(64))); }`)
  await executable('docker', `if(process.argv.slice(2,4).join(' ')==='image inspect')console.log('sha256:'+'1'.repeat(64));else throw new Error('Unexpected Docker mutation');`)
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  await createProfile('target', { kind: 'hitch', model: 'test-model', adapter: 'pi', executable: binary, root: join(root, 'hitch-state'), baseImage: image, passEnv: ['OPENAI_API_KEY'] })
  await selectDefaultProfile('target', 'target')
}

it('allows explicit Codex proxy variable names while rejecting arbitrary host environment', async () => {
  const binary = await executable('codex-proxy', '')
  const passEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
  vi.stubEnv('HTTPS_PROXY', 'http://fixture:PROXY_CREDENTIAL_CANARY@127.0.0.1:12345')
  await createProfile('proxy-meta', { kind: 'codex', model: 'fixture-model', executable: binary, authHome: root, passEnv })
  const saved = await profile('proxy-meta')
  expect(saved.passEnv).toEqual(passEnv)
  expect(processProfile(saved as Parameters<typeof processProfile>[0]).passEnv).toEqual(passEnv)
  expect(await readFile(join(root, 'profiles/proxy-meta.json'), 'utf8')).not.toContain('PROXY_CREDENTIAL_CANARY')
  for (const name of ['NODE_OPTIONS', 'PATH', 'GEAR_META_SECRET', 'HTTP_PROXY=value'])
    expect(() => validateProfile({ ...saved, passEnv: [name] })).toThrow()
})
it('creates native profiles, pins the matching runtime and initializes selected profiles', async () => {
  await hitch(); await codex(); await selectDefaultProfile('meta', 'meta')
  const location = join(root, 'project')
  await initProject(location)
  expect((await resolveProject(location)).config.target).toMatchObject({ adapter: 'pi', profile: 'target' })
  expect((await resolveProject(location)).config.meta.profile).toBe('meta')
  const saved = await profile('meta')
  expect('kind' in saved && saved.kind).toBe('codex')
  expect(processProfile(saved as Parameters<typeof processProfile>[0]).command[1]).toMatch(/assets\/codex-meta-runner.mjs$/)
  if ('kind' in saved && saved.kind === 'codex') {
    expect(processProfile(saved).timeoutMs).toBe(saved.configuration.timeoutMs + 30_000)
  }
  expect((await stat(join(root, 'profiles/meta.json'))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(root, 'profiles/meta.json'), 'utf8')).not.toContain('SECRET')
  await expect(saveProfile('meta', processSettings())).rejects.toMatchObject({ code: 'profile-exists' })
  await expect(selectDefaultProfile('meta', 'target')).rejects.toMatchObject({ code: 'profile-role-mismatch' })
  await expect(initProject(join(root, 'wrong'), { adapter: 'dsh' })).rejects.toMatchObject({ code: 'profile-adapter-mismatch' })
  expect(await readdir(root)).not.toContain('wrong')
})
it('selects project profiles through the controller and preserves unrelated configuration', async () => {
  const location = join(root, 'project'); await initProject(location)
  const controller = new ProjectController(new ProjectApplication(location, { provider: async () => { throw new Error('Not called') } }))
  await controller.invoke('profile.import', { name: 'custom', profile: processSettings() })
  await controller.invoke('profile.select', { name: 'custom', role: 'meta' })
  expect((await resolveProject(location)).config).toMatchObject({ algorithm: 'gepa', meta: { profile: 'custom' }, target: { profile: 'default-target' } })
  expect(await defaultProfiles()).toEqual({})
  await expect(controller.invoke('profile.select', { name: 'custom', role: 'typo' })).rejects.toMatchObject({ code: 'invalid-command-params' })
  await expect(controller.invoke('profile.import', { name: '../escape', profile: processSettings() })).rejects.toMatchObject({ code: 'invalid-profile-name' })
  await expect(controller.invoke('profile.import', { name: 'secret', profile: { ...processSettings(), passEnv: ['KEY=value'] } })).rejects.toMatchObject({ code: 'invalid-profile' })
  await expect(controller.invoke('profile.import', { name: 'bad', profile: { ...processSettings(), configuration: [] } })).rejects.toMatchObject({ code: 'invalid-profile' })
  expect(await controller.invoke('profile.list')).toMatchObject({ profiles: [{ name: 'custom', kind: 'process', valid: true }] })
  await controller.dispose()
})
it('persists explicit Hitch concurrency through profile creation', async () => {
  const controller = new ProjectController(new ProjectApplication(root, { provider: async () => { throw new Error('Not called') } }))
  const options = { kind: 'hitch', model: 'fixture', adapter: 'dsh', executable: process.execPath, root: join(root, 'hitch'), baseImage: image, maxConcurrent: 4 }
  await controller.invoke('profile.create', { name: 'parallel', options })
  expect(await profile('parallel')).toMatchObject({ kind: 'hitch', maxConcurrent: 4 })
  await expect(controller.invoke('profile.create', { name: 'bad', options: { ...options, maxConcurrent: 0 } })).rejects.toMatchObject({ code: 'invalid-profile' })
  await controller.dispose()
})
it('round-trips native arguments through Hitch profile creation and import', async () => {
  const controller = new ProjectController(new ProjectApplication(root, { provider: async () => { throw new Error('Not called') } }))
  const agentArgs = ['--patch', '/opt/provider with spaces.json']
  await controller.invoke('profile.create', { name: 'native-args', options: {
    kind: 'hitch', model: 'fixture', adapter: 'dsh', executable: process.execPath,
    root: join(root, 'hitch'), baseImage: image, agentArgs,
  } })
  const saved = await profile('native-args')
  expect(saved).toMatchObject({ agentArgs })
  await controller.invoke('profile.import', { name: 'imported-args', profile: saved })
  expect(await profile('imported-args')).toEqual(saved)
  for (const invalid of [null, '--patch', [1], ['bad\0argument']])
    expect(() => validateProfile({ ...saved, agentArgs: invalid })).toThrow('agentArgs')
  await controller.dispose()
})
it('reports missing credentials separately and never calls a model or exposes credential values', async () => {
  await hitch(); await codex('meta', undefined, ['CODEX_API_KEY', 'HTTP_PROXY']); await selectDefaultProfile('meta', 'meta')
  vi.stubEnv('HTTP_PROXY', 'http://fixture:SECRET_PROXY@127.0.0.1:12345')
  let result = await doctor(root)
  expect(result.checks.every((check) => check.status === 'passed'), JSON.stringify(result.checks)).toBe(true)
  expect(result.authentication).toMatchObject({ target: { status: 'not_configured' }, meta: { status: 'not_configured' } })
  expect(result.ready_for_refine_smoke).toBe(false)
  vi.stubEnv('CODEX_API_KEY', 'SECRET_CODEX_KEY'); vi.stubEnv('OPENAI_API_KEY', 'SECRET_TARGET_KEY')
  result = await doctor(root)
  expect(result.ready_for_seed_smoke).toBe(true)
  expect(result.ready_for_refine_smoke).toBe(true)
  expect(result.authentication.meta).toEqual({ status: 'environment_present', names: ['CODEX_API_KEY'] })
  expect(result.model_access).toBe('not_checked')
  expect(result.model_requests).toBe(0)
  expect(result.benchmark).toBe('not_run')
  expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('checks the same file-based Codex login used by operations and refuses symlinked auth files', async () => {
  const home = join(root, 'auth'); await mkdir(home)
  await writeFile(join(home, 'auth.json'), '{"token":"SECRET_TOKEN"}')
  await codex('login', home); await selectDefaultProfile('login', 'meta')
  expect((await doctor(root)).authentication.meta?.status).toBe('local_login_present')
  await rm(join(home, 'auth.json')); await writeFile(join(root, 'elsewhere'), '{}'); await symlink(join(root, 'elsewhere'), join(home, 'auth.json'))
  const result = await doctor(root)
  expect(result.checks.find((check) => check.component === 'meta.profile')?.status).toBe('failed')
  expect(result.ready_for_refine_smoke).toBe(false)
  expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('does not classify a broken project or unavailable selected image as ready', async () => {
  await hitch(); vi.stubEnv('OPENAI_API_KEY', 'SECRET')
  await writeFile(join(root, 'docker'), '#!/bin/sh\nexit 1\n'); await chmod(join(root, 'docker'), 0o700)
  const result = await doctor(root)
  expect(result.checks.find((check) => check.component === 'target.dependencies')?.status).toBe('failed')
  expect(result.ready_for_seed_smoke).toBe(false)
  await writeFile(join(root, 'gear.yaml'), 'version: broken\n')
  expect((await doctor(root)).checks.find((check) => check.component === 'configuration')?.status).toBe('failed')
})
it('keeps the previous Python environment selected when an installation fails', async () => {
  const binary = await executable('python', `const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='-c')console.log('3.12.1');
else if(process.argv[2]==='-m'&&process.argv[3]==='venv') {const bin=path.join(process.argv[4],'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'python'),'#!/bin/sh\\nexit 1\\n',{mode:0o700});}else process.exit(1);`)
  await mkdir(managedPythonRoot(), { recursive: true })
  const pointer = join(managedPythonRoot(), 'current.json')
  await writeFile(pointer, '{"environment":"env-old"}\n')
  await expect(setupPython(binary)).rejects.toMatchObject({ code: 'python-setup-failed' })
  expect(await readFile(pointer, 'utf8')).toBe('{"environment":"env-old"}\n')
  expect((await readdir(managedPythonRoot())).filter((name) => name.startsWith('env-'))).toEqual([])
})

it('setup prepares the matrix harness, Harbor and image, then verifies daemon startup', async () => {
  const { setup } = await import('../../src/application/setup.js')
  const binary = await executable('python-ok', `const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='-c')console.log('3.12.1');
else if(process.argv[2]==='-m'&&process.argv[3]==='venv'){const bin=path.join(process.argv[4],'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'python'),'#!/bin/sh\\nexit 0\\n',{mode:0o700});}`)
  const log = join(root, 'calls.jsonl'), marker = join(root, 'daemon-running')
  const hitchBinary = await executable('hitch-setup', `const fs=require('node:fs');const args=process.argv.slice(4);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='prepare')console.log(JSON.stringify({resolved_revision:{identity:'runtime-identity'}}));
else if(args[0]==='eval'&&args[1]==='setup')console.log('{}');
else if(args[0]==='daemon'&&args[1]==='status')console.log(JSON.stringify({status:fs.existsSync(${JSON.stringify(marker)})?'running':'stopped'}));
else if(args[0]==='daemon'&&args[1]==='start'){fs.writeFileSync(${JSON.stringify(marker)},'yes');console.log('{}');}
else throw new Error('Unexpected Hitch action');`)
  await executable('docker', `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='pull')process.exit(0);else if(args[0]==='image')console.log(JSON.stringify([${JSON.stringify(image)}]));else process.exit(1);`)
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  const result = await setup({ python: binary, hitch: true, adapter: 'pi', hitchExecutable: hitchBinary, hitchRoot: join(root, 'hitch') })
  expect(result.execution).toMatchObject({ harness: 'pi@version:0.84.1', harness_identity: 'runtime-identity', harbor: '0.21.0', image, daemon: 'running' })
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(calls).toContainEqual(['eval', 'setup', 'harbor', '--version', '0.21.0', '--json', '--python', binary])
  expect(calls.at(-1)).toEqual(['daemon', 'status', '--json'])
  expect(result.authentication).toBe('not_checked')
  expect(result.benchmark).toBe('not_run')
  const selected = await readFile(join(managedPythonRoot(), 'current.json'), 'utf8')
  await expect(setup({ python: binary, image: 'other' })).rejects.toMatchObject({ code: 'invalid-setup-options' })
  expect(await readFile(join(managedPythonRoot(), 'current.json'), 'utf8')).toBe(selected)
})

it('pins a new DSH profile to the startup-verified runtime matrix', async () => {
  const binary = await executable('hitch-pinned', '')
  await executable('docker', `console.log('sha256:'+'1'.repeat(64))`)
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  await createProfile('dsh-target', { kind: 'hitch', model: 'fixture-model', adapter: 'dsh',
    executable: binary, root: join(root, 'hitch'), baseImage: image })
  expect(await profile('dsh-target')).toMatchObject({ harnessRef: 'deepseek@version:0.1.5-rc.3' })
})
