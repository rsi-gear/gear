import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SubprocessHarnessCompiler } from '../../src/harness/compiler.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const validReport = `const report = {
  schemaVersion: 1, candidateDigest: request.candidateDigest,
  identity: { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', lockDigest: 'sha256:' + 'a'.repeat(64) },
  load: { status: 'passed' }, cleanup: { status: 'passed' },
  skillDiscovery: { status: 'not_checked', code: 'NO_CANDIDATE_SKILLS', expected: 0, checked: 0 },
  skillRead: { status: 'not_checked', code: 'NO_CANDIDATE_SKILLS', expected: 0, checked: 0 }
};`

async function fixture(script: string, timeoutMs = 5000) {
  const git = await createGitHarnessFixture()
  roots.push(git.root)
  await mkdir(join(git.repository, 'node_modules'))
  const program = join(git.root, 'fixed-check.mjs')
  const trace = join(git.root, 'trace.json')
  await writeFile(program, `import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await writeFile(process.env.TRACE_PATH, JSON.stringify({repository:request.repository}));
${script}\n`)
  const compiler = new SubprocessHarnessCompiler({ command: process.execPath, args: [program],
    reportProtocol: 'gear-runtime-check-v1', runtimeRoot: git.repository,
    maxReportBytes: 4096, timeoutMs, env: { TRACE_PATH: trace } })
  return { git, trace, compiler }
}

it.each(['missing', 'malformed', 'mismatched', 'oversized', 'empty success', 'zero skills passed'])(
  'rejects a zero-exit compiler with %s runtime evidence', async variant => {
    const scripts: Record<string, string> = {
      missing: '',
      malformed: 'await writeFile(request.reportPath, "bad-json")',
      mismatched: `${validReport} report.candidateDigest = 'sha256:' + 'b'.repeat(64); await writeFile(request.reportPath, JSON.stringify(report));`,
      oversized: 'await writeFile(request.reportPath, "x".repeat(5000))',
      'empty success': `${validReport} report.load = {status:'not_checked'}; await writeFile(request.reportPath, JSON.stringify(report));`,
      'zero skills passed': `${validReport} report.skillRead = {status:'passed', expected:0, checked:0}; await writeFile(request.reportPath, JSON.stringify(report));`,
    }
    const { git, compiler, trace } = await fixture(scripts[variant]!)
    await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest)).rejects.toMatchObject({ report: { ok: false } })
    const { repository } = JSON.parse(await readFile(trace, 'utf8'))
    await expect(readFile(join(repository, 'harness/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('preserves the failed runtime stage even when the checker exits nonzero', async () => {
  const { git, compiler } = await fixture(`${validReport}
report.load = {status:'failed', code:'INIT_FAILED', message:'plugin initialization sentinel'};
await writeFile(request.reportPath, JSON.stringify(report)); process.exitCode = 1;`)
  await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest)).rejects.toMatchObject({
    report: { runtime: { load: { status: 'failed', code: 'INIT_FAILED' } } },
  })
})

it('uses the bounded report file independently of noisy stdout and stderr', async () => {
  const { git, compiler } = await fixture(`${validReport}
process.stdout.write('log'.repeat(100000)); process.stderr.write('log'.repeat(100000));
await writeFile(request.reportPath, JSON.stringify(report));`)
  await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest)).resolves.toMatchObject({ ok: true })
})

it.each(['failed', 'incomplete'])('does not accept %s prompt assembly after successful loading', async mode => {
  const { git, compiler } = await fixture(`${validReport}
report.promptAssembly = ${mode === 'failed'
    ? "{status:'failed', code:'PROMPT_ASSEMBLY_FAILED', message:'prompt sentinel'}"
    : "{status:'not_checked', code:'PREVIOUS_STAGE_NOT_COMPLETED'}"};
await writeFile(request.reportPath, JSON.stringify(report));`)
  await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest))
    .rejects.toMatchObject({ report: { ok: false, runtime: { promptAssembly: {
      status: mode === 'failed' ? 'failed' : 'not_checked',
    } } } })
})

it('reports prompt assembly as unverified for an older checker without that stage', async () => {
  const { git, compiler } = await fixture(`${validReport}
await writeFile(request.reportPath, JSON.stringify(report));`)
  await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest))
    .resolves.toMatchObject({ ok: true, runtime: {
      promptAssembly: { status: 'not_checked', code: 'PROMPT_ASSEMBLY_NOT_REPORTED' },
    } })
})

it('rejects runtime evidence produced after the snapshot content was changed', async () => {
  const { git, compiler } = await fixture(`${validReport}
await writeFile(request.repository + '/harness/manifest.json', '{}');
await writeFile(request.reportPath, JSON.stringify(report));`)
  await expect(compiler.compile(git.repository, new AbortController().signal, git.manifest))
    .rejects.toThrow('SNAPSHOT_CHANGED_DURING_CHECK')
  expect(JSON.parse(await readFile(join(git.repository, 'harness/manifest.json'), 'utf8'))).toEqual(git.manifest)
})

it.skipIf(process.platform === 'win32').each(['timeout', 'parent exits', 'abort'])(
  'reaps a child process and removes the snapshot after %s', async mode => {
    const { git, compiler, trace } = await fixture(`
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'inherit'});
await writeFile(process.env.TRACE_PATH, JSON.stringify({repository:request.repository,pid:child.pid}));
${mode === 'parent exits' ? 'process.exit(0)' : 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'}
`, 700)
    const controller = new AbortController()
    const operation = compiler.compile(git.repository, controller.signal, git.manifest)
    // Observe the fixture's external receipt rather than sleep for a guessed
    // process startup time, and attach rejection handling before cancellation.
    const result = operation.catch(error => error)
    let receipt: { pid?: number; repository: string } | undefined
    for (let i = 0; i < 100; i++) {
      try { receipt = JSON.parse(await readFile(trace, 'utf8')); if (receipt?.pid) break } catch {}
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(receipt?.pid).toBeTypeOf('number')
    if (mode === 'abort') controller.abort(new Error('cancel sentinel'))
    const error = await result
    expect(error).toBeInstanceOf(Error)
    if (mode === 'abort') expect(error.message).toBe('cancel sentinel')
    for (let i = 0; i < 100; i++) {
      try { process.kill(receipt!.pid!, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(() => process.kill(receipt!.pid!, 0)).toThrow()
    await expect(readFile(join(receipt!.repository, 'harness/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('reports legacy no-op runtime coverage as not checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compiler-noop-'))
  roots.push(root)
  await mkdir(join(root, 'harness'))
  const compiler = new SubprocessHarnessCompiler({ command: '/usr/bin/true' })
  await expect(compiler.compile(root, new AbortController().signal)).resolves.toMatchObject({ ok: true,
    runtime: { load: { status: 'not_checked' }, skillRead: { status: 'not_checked' } } })
})
