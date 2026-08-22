import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { basename, isAbsolute } from 'node:path'
import type { CandidateWorkspaceManager } from './workspace.js'

function assertRelativeSearchPath(path: string): void {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..')) {
    throw new Error('search path must be relative to the active candidate workspace')
  }
  if (path.split('/').some(part => part === '.git')) throw new Error('candidate Git metadata is not searchable')
}

/** Trusted adapter for DSH's fixed ripgrep tools. It is intentionally not a
 * general subprocess capability and therefore rejects terminal allocation. */
export class CandidateSearchSubprocess extends SubprocessRuntime {
  constructor(
    ctx: Context,
    private readonly upstream: SubprocessRuntime,
    private readonly manager: CandidateWorkspaceManager,
    private readonly metaSessionId: string,
  ) { super(ctx) }

  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.upstream.resolveExecutable(command, env, signal)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = this.manager.resolve(this.metaSessionId)
    if (handle.state !== 'open') throw new Error('candidate search is unavailable after workspace sealing')
    const executable = spec.argv[0]
    if (executable === undefined || (basename(executable) !== 'rg' && executable !== `${process.execPath}-rg`)
      || spec.argv.length < 2 || !spec.argv.some(arg => arg === '--no-config')
      || spec.argv.some(arg => arg === '--follow' || arg === '-L' || arg === '--pre' || arg.startsWith('--pre='))) {
      throw new Error('candidate subprocess only accepts DSH fixed ripgrep invocations')
    }
    const separator = spec.argv.lastIndexOf('--')
    if (separator >= 0) for (const path of spec.argv.slice(separator + 1)) assertRelativeSearchPath(path)
    return this.upstream.spawn({ ...spec, cwd: handle.targetPath, env: {} })
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal processes are unavailable through the candidate search adapter'))
  }
}
