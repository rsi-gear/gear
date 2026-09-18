import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  acquireAirGappedSandbox, assertAirGappedSandboxActive, createAirGappedSandboxConfig, sandboxSystemReadPaths,
  type AirGappedSandboxLease, type LinuxSandboxIsolation,
} from '../sandbox.js'

const execFile = promisify(execFileCallback)

export type NotebookSandboxMode = 'required' | 'disabled'

export interface NotebookKernelSandboxOptions {
  mode?: NotebookSandboxMode
  linuxIsolation?: LinuxSandboxIsolation
  scratchRoot: string
  protectedPaths?: readonly string[]
}

export interface SandboxedKernelLaunch {
  child: ChildProcessWithoutNullStreams
  cwd: string
  cleanup(): Promise<void>
}

interface PythonRuntime {
  executable: string
  readPaths: string[]
}

const SAFE_ENV_KEYS = [
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
] as const

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined && path.startsWith('/')).map(path => resolve(path)))]
}

async function canonicalPaths(paths: readonly string[]): Promise<string[]> {
  return uniquePaths(await Promise.all(paths.map(async path => {
    if (!path.startsWith('/')) return undefined
    try {
      return await realpath(path)
    } catch {
      return resolve(path)
    }
  })))
}

function containsPath(parent: string, child: string): boolean {
  const relative = child.slice(parent.length)
  return child === parent || (child.startsWith(parent) && relative.startsWith('/'))
}

async function inspectPython(pythonExecutable: string): Promise<PythonRuntime> {
  const script = [
    'import json, os, sys, sysconfig',
    'values = [sys.executable, sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix]',
    'values += list(sys.path)',
    'values += list(sysconfig.get_paths().values())',
    'print(json.dumps({"executable": sys.executable, "paths": [os.path.realpath(value) for value in values if value and os.path.isabs(value)]}))',
  ].join('; ')
  const { stdout } = await execFile(pythonExecutable, ['-I', '-c', script], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const inspected = JSON.parse(stdout) as { executable?: unknown; paths?: unknown }
  if (typeof inspected.executable !== 'string'
    || !Array.isArray(inspected.paths)
    || inspected.paths.some(path => typeof path !== 'string')) {
    throw new Error('python runtime inspection returned an invalid path list')
  }
  const executable = resolve(inspected.executable)
  const canonicalExecutable = await realpath(executable)
  const readPaths = uniquePaths([executable, dirname(executable), canonicalExecutable, dirname(canonicalExecutable), ...inspected.paths])
  const userHome = resolve(homedir())
  if (readPaths.some(path => path === '/' || path === userHome || containsPath(path, userHome))) {
    throw new Error('python runtime path is too broad for the meta notebook sandbox')
  }
  return {
    executable,
    readPaths,
  }
}

function sanitizedEnvironment(scratch: string, python: PythonRuntime): NodeJS.ProcessEnv {
  const systemRoots = sandboxSystemReadPaths()
  const inheritedSystemPath = (process.env.PATH ?? '').split(delimiter)
    .filter(path => path.startsWith('/') && systemRoots.some(root => containsPath(root, resolve(path))))
  const env: NodeJS.ProcessEnv = {
    PATH: uniquePaths([dirname(python.executable), ...inheritedSystemPath]).join(delimiter),
    HOME: join(scratch, 'home'),
    TMPDIR: join(scratch, 'tmp'),
    XDG_CACHE_HOME: join(scratch, 'cache'),
    XDG_CONFIG_HOME: join(scratch, 'config'),
    XDG_DATA_HOME: join(scratch, 'data'),
    IPYTHONDIR: join(scratch, 'ipython'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

export class NotebookKernelSandbox {
  private initialized = false
  private initialization: Promise<void> | undefined
  private disposed = false
  private python: PythonRuntime | undefined
  private sandboxLease: AirGappedSandboxLease | undefined

  constructor(
    private readonly pythonExecutable: string,
    private readonly helperPath: string,
    private readonly options: NotebookKernelSandboxOptions,
  ) {}

  async initialize(): Promise<void> {
    if (this.options.mode === 'disabled' || this.initialized) return
    if (this.disposed) throw new Error('meta notebook sandbox is disposed')
    if (this.initialization !== undefined) return this.initialization
    const initialization = (async () => {
      const sandboxLease = await acquireAirGappedSandbox(this.options.linuxIsolation, 'meta notebook')
      try {
        this.python = await inspectPython(this.pythonExecutable)
        if (this.disposed) throw new Error('meta notebook sandbox was disposed during initialization')
        this.sandboxLease = sandboxLease
        this.initialized = true
      } catch (error) {
        await sandboxLease.release()
        throw error
      }
    })()
    this.initialization = initialization
    try {
      await initialization
    } finally {
      if (this.initialization === initialization && !this.initialized) this.initialization = undefined
    }
  }

  async launch(sessionId: string, logicalCwd: string): Promise<SandboxedKernelLaunch> {
    if (this.options.mode === 'disabled') {
      const child = spawn(this.pythonExecutable, ['-u', this.helperPath], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { child, cwd: resolve(logicalCwd), cleanup: async () => {} }
    }
    await this.initialize()
    if (this.disposed || this.python === undefined) throw new Error('meta notebook sandbox is unavailable')

    const requestedRoot = resolve(this.options.scratchRoot)
    const forbiddenRoots = ['/', resolve(homedir()), resolve(tmpdir())]
    if (forbiddenRoots.includes(requestedRoot)) throw new Error('meta notebook scratchRoot is too broad')
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
    await chmod(requestedRoot, 0o700)
    const root = await realpath(requestedRoot)
    if (forbiddenRoots.includes(root) || this.python.readPaths.some(path => containsPath(path, root) || containsPath(root, path))) {
      throw new Error('meta notebook scratchRoot overlaps a broad or executable runtime path')
    }
    const protectedPaths = await canonicalPaths(this.options.protectedPaths ?? [])
    const runtimeAllowlist = uniquePaths([...sandboxSystemReadPaths(), ...this.python.readPaths])
    const exposed = protectedPaths.find(path => runtimeAllowlist.some(runtime => containsPath(runtime, path)))
    if (exposed !== undefined) throw new Error(`protected control-plane path overlaps the Python runtime allowlist: ${exposed}`)
    const helper = await realpath(this.helperPath)
    if (containsPath(root, helper) || containsPath(helper, root)) {
      throw new Error('meta notebook scratchRoot overlaps the packaged helper')
    }
    const sessionKey = createHash('sha256').update(sessionId).digest('hex').slice(0, 20)
    const scratch = await realpath(await mkdtemp(join(root, `${sessionKey}-`)))
    await Promise.all(['home', 'tmp', 'cache', 'config', 'data', 'ipython'].map(path => mkdir(join(scratch, path), { mode: 0o700 })))

    try {
      const config = await createAirGappedSandboxConfig({
        linuxIsolation: this.options.linuxIsolation,
        allowRead: uniquePaths([...sandboxSystemReadPaths(), ...this.python.readPaths, helper, scratch]),
        allowWrite: [scratch],
      })
      const command = [this.python.executable, '-I', '-u', helper].map(shellQuote).join(' ')
      assertAirGappedSandboxActive(config)
      const wrapped = await SandboxManager.wrapWithSandboxArgv(command, '/bin/bash', config)
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
          cwd: scratch,
          env: sanitizedEnvironment(scratch, this.python),
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        SandboxManager.cleanupAfterCommand()
        throw error
      }
      return {
        child,
        cwd: scratch,
        cleanup: async () => {
          SandboxManager.cleanupAfterCommand()
          await rm(scratch, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await rm(scratch, { recursive: true, force: true })
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.initialization?.catch(() => {})
    await this.sandboxLease?.release()
    this.initialized = false
    this.initialization = undefined
    this.python = undefined
    this.sandboxLease = undefined
  }
}
