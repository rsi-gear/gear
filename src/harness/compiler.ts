import { spawn } from 'node:child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { open, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HarnessCompiler } from './builder.js'
import type { HarnessManifest } from '../types.js'
import { CompilerCheckError, parseRuntimeReport, uncheckedRuntime, type CompilerCheckReport } from './check-report.js'
import { createCheckSnapshot } from './check-snapshot.js'
import {
  assertAirGappedSandboxActive, createAirGappedSandboxConfig, sandboxSystemReadPaths,
  type LinuxSandboxIsolation,
} from '../sandbox.js'

export interface SubprocessCompilerOptions {
  command: string
  args?: string[]
  timeoutMs?: number
  env?: Record<string, string>
  sandboxMode?: 'required' | 'disabled'
  linuxIsolation?: LinuxSandboxIsolation
  targetRoot?: string
  reportProtocol?: 'gear-runtime-check-v1'
  runtimeRoot?: string
  maxReportBytes?: number
  readPaths?: string[]
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

async function readReport(path: string, limit: number, digest: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error('runtime report must be a regular file')
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error('runtime report exceeded compiler.maxReportBytes')
    return parseRuntimeReport(buffer.subarray(0, bytesRead).toString('utf8'), digest)
  } finally { await file.close() }
}

export class SubprocessHarnessCompiler implements HarnessCompiler {
  get runtimeValidation(): boolean { return this.options.reportProtocol !== undefined }
  constructor(private readonly options: SubprocessCompilerOptions) {
    if (options.readPaths?.some(path => !isAbsolute(path))) throw new TypeError('compiler.readPaths must contain absolute fixed toolchain paths')
    if (options.reportProtocol !== undefined && (!options.runtimeRoot || !isAbsolute(options.runtimeRoot))) {
      throw new TypeError('reported compiler requires an absolute fixed runtimeRoot')
    }
    if (options.maxReportBytes !== undefined && (!Number.isSafeInteger(options.maxReportBytes) || options.maxReportBytes < 1024)) {
      throw new TypeError('compiler.maxReportBytes must be an integer of at least 1024')
    }
  }

  async compile(worktree: string, signal: AbortSignal, manifest?: HarnessManifest): Promise<CompilerCheckReport> {
    signal.throwIfAborted()
    const reported = this.options.reportProtocol !== undefined
    const candidateDigest = manifest?.digest ?? ''
    if (reported && manifest === undefined) throw new Error('reported compiler requires the current candidate manifest')
    let snapshot: Awaited<ReturnType<typeof createCheckSnapshot>> | undefined
    let sandboxWrapped = false
    let report: CompilerCheckReport | undefined
    const controller = new AbortController()
    const timeoutMs = this.options.timeoutMs ?? 120_000
    const timeout = setTimeout(() => controller.abort(new Error(`harness compiler timed out after ${timeoutMs}ms`)), timeoutMs)
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      let command = this.options.command
      let args = this.options.args ?? []
      let cwd = worktree
      let env = { ...this.options.env }
      const runtimeRoot = reported ? await realpath(this.options.runtimeRoot!) : undefined
      if (reported) {
        snapshot = await createCheckSnapshot(worktree, this.options.targetRoot ?? 'harness', manifest!, combined, runtimeRoot!)
        cwd = join(snapshot.writable, 'workspace')
        env = {
          ...env, HOME: snapshot.home, DSH_HOME: snapshot.home,
          XDG_CONFIG_HOME: join(snapshot.home, '.config'), XDG_CACHE_HOME: join(snapshot.home, '.cache'),
          XDG_DATA_HOME: join(snapshot.home, '.local', 'share'), TMPDIR: join(snapshot.writable, 'tmp'),
          TMP: join(snapshot.writable, 'tmp'), TEMP: join(snapshot.writable, 'tmp'), DSH_TELEMETRY_DISABLED: '1',
        }
      }
      if (this.options.sandboxMode === 'required') {
        if (!isAbsolute(command)) throw new Error('sandboxed harness compiler command must be an absolute fixed toolchain path')
        const canonicalCommand = await realpath(command)
        const config = await createAirGappedSandboxConfig({
          linuxIsolation: this.options.linuxIsolation,
          allowRead: [
            ...sandboxSystemReadPaths(), dirname(resolve(command)), dirname(dirname(canonicalCommand)),
            ...(this.options.readPaths ?? []),
            // Keep read-only and writable siblings separate: on Linux a later
            // read-only bind of their parent would mask the scratch write bind.
            ...(snapshot === undefined ? [resolve(worktree)] : [snapshot.repository, snapshot.writable, runtimeRoot!,
              ...args.filter(isAbsolute).map(path => dirname(path))]),
          ],
          allowWrite: [snapshot?.writable ?? join(resolve(worktree), this.options.targetRoot ?? 'harness')],
        })
        assertAirGappedSandboxActive(config)
        const wrapped = await SandboxManager.wrapWithSandboxArgv([command, ...args].map(shellQuote).join(' '), '/bin/bash', config)
        command = wrapped.argv[0]!
        args = wrapped.argv.slice(1)
        sandboxWrapped = true
      }
      combined.throwIfAborted()
      const child = spawn(command, args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      const kill = (kind: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, kind)
          else child.kill(kind)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      let killTimer: NodeJS.Timeout | undefined
      const terminate = (): void => {
        kill('SIGTERM')
        killTimer ??= setTimeout(() => kill('SIGKILL'), 1000)
      }
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      child.stdout!.on('data', (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]).subarray(-16_000) })
      child.stderr!.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-16_000) })
      child.stdin!.on('error', () => {})
      child.stdin!.end(reported ? JSON.stringify({
        schemaVersion: 1, candidateDigest, repository: snapshot!.repository, runtimeRoot,
        targetRoot: this.options.targetRoot ?? 'harness',
        reportPath: join(snapshot!.writable, 'report.json'),
      }) : undefined)
      combined.addEventListener('abort', terminate, { once: true })
      if (combined.aborted) terminate()
      try {
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
          child.once('error', reject)
          // Parent exit does not mean descendants released pipes/resources.
          child.once('exit', () => terminate())
          child.once('close', (code, childSignal) => resolvePromise({ code, signal: childSignal }))
        })
        combined.throwIfAborted()
        if (!reported) {
          if (result.code !== 0) throw new Error(`harness compiler failed (${result.signal ?? result.code ?? 'unknown'})\n${stderr.toString() || stdout.toString()}`)
          report = { ok: true, status: 'passed', runtime: uncheckedRuntime(candidateDigest) }
        } else {
          let runtime
          try { runtime = await readReport(join(snapshot!.writable, 'report.json'), this.options.maxReportBytes ?? 128 * 1024, candidateDigest) }
          catch (error) { throw new Error(`runtime report invalid (${result.signal ?? result.code}): ${String(error)}\n${stderr.toString() || stdout.toString()}`) }
          const failed = [runtime.load, runtime.promptAssembly, runtime.skillDiscovery, runtime.skillRead, runtime.cleanup].find(stage => stage?.status === 'failed')
          const missing = runtime.load.status !== 'passed' || runtime.cleanup.status !== 'passed'
            || runtime.promptAssembly?.status === 'not_checked' && runtime.promptAssembly.code !== 'PROMPT_ASSEMBLY_NOT_REPORTED'
            || [runtime.skillDiscovery, runtime.skillRead].some(stage => stage.status === 'not_checked'
              && !['NO_CANDIDATE_SKILLS', 'MODEL_INVOCATION_DISABLED'].includes(stage.code ?? ''))
          const ok = result.code === 0 && failed === undefined && !missing
          if (ok) await snapshot!.verify()
          report = {
            ok, status: ok ? 'passed' : 'failed', runtime,
            ...(!ok ? { code: failed?.code ?? 'RUNTIME_CHECK_INCOMPLETE',
              message: `${failed?.message ?? `runtime checker failed or returned incomplete coverage (${result.signal ?? result.code})`}\n${stderr.toString().slice(-2000)}`.slice(-4000) } : {}),
          }
        }
      } finally {
        kill('SIGKILL')
        if (killTimer !== undefined) clearTimeout(killTimer)
        combined.removeEventListener('abort', terminate)
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      let runtime = uncheckedRuntime(candidateDigest, 'COMPILER_DID_NOT_COMPLETE')
      if (snapshot !== undefined) {
        try { runtime = await readReport(join(snapshot.writable, 'report.json'), this.options.maxReportBytes ?? 128 * 1024, candidateDigest) } catch {}
      }
      if (runtime.activeStage !== undefined) runtime[runtime.activeStage] = {
        status: 'failed', code: controller.signal.aborted ? 'COMPILER_TIMEOUT' : 'COMPILER_CHECK_FAILED',
        message: String(error instanceof Error ? error.message : error).slice(-4000),
      }
      report = {
        ok: false, status: 'failed', code: controller.signal.aborted ? 'COMPILER_TIMEOUT' : 'COMPILER_CHECK_FAILED',
        message: String(error instanceof Error ? error.message : error).slice(-4000),
        runtime,
      }
    } finally {
      clearTimeout(timeout)
      if (sandboxWrapped) SandboxManager.cleanupAfterCommand()
      if (snapshot !== undefined) {
        try { await rm(snapshot.root, { recursive: true, force: true }) }
        catch (error) {
          report = { ok: false, status: 'failed', code: 'SNAPSHOT_CLEANUP_FAILED', message: String(error).slice(-4000),
            runtime: { ...(report?.runtime ?? uncheckedRuntime(candidateDigest)),
              cleanup: { status: 'failed', code: 'SNAPSHOT_CLEANUP_FAILED', message: String(error).slice(-4000) } } }
        }
      }
    }
    if (!report!.ok) throw new CompilerCheckError(report!)
    return report!
  }
}
