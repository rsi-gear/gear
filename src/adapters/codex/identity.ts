import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalDigest } from '../../domain/canonical.js'
import type { CodexConfiguration } from './contracts.js'
import { builtinPolicyImplementationDigest } from '../python/builtin-policy.js'
import { resolveCodexExecutable } from './executable.js'

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return `sha256:${hash.digest('hex')}`
}
/** Hash the actual CLI binary and packaged controller, never a claimed runtime label. */
export async function describeCodex(config: CodexConfiguration): Promise<{
  identity: string
  executable: string
  version: string
  codeModeHost?: string
  caCertificates?: string
}> {
  const executable = await resolveCodexExecutable(config.executable)
  const companion = join(dirname(executable), 'codex-code-mode-host')
  const codeModeHost = await access(companion, constants.X_OK)
    .then(() => realpath(companion))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
  // macOS native trust discovery uses IPC unavailable inside the strict sandbox.
  // Bind the system PEM bundle instead of weakening the sandbox or TLS validation.
  const caCertificates = process.platform === 'darwin' ? await realpath('/etc/ssl/cert.pem') : undefined
  const { stdout } = await promisify(execFile)(executable, ['--version'], {
    timeout: 10_000,
    maxBuffer: 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  })
  const version = stdout.trim()
  if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version))
    throw new Error('Unsupported Codex executable')
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const implementation = await Promise.all(
    [
      'contracts',
      'auth',
      'identity',
      'executable',
      'runner',
      'journal',
      'sandbox',
      'execution',
      'cleanup',
      'usage',
      'experience',
      'trajectory-gateway',
      '../artifacts/reader',
      '../artifacts/access',
      '../storage/trajectory',
      '../skill/server',
      '../hitch/trajectory',
      '../hitch/native-source',
      '../hitch/transport',
      '../hitch/settings',
      '../python/packaged-policy',
      '../python/builtin-policy',
      '../storage/experience',
      '../python/runtime',
      '../python/interpreter',
      '../storage/atomic',
      '../storage/file-lock',
      '../storage/targets',
      '../dsh/harness',
      '../pi/harness',
      '../../domain/canonical',
      '../../domain/mutation-policy',
      '../../domain/algorithm-schema',
      '../../sandbox',
    ].map((name) => readFile(new URL(`${name}${extension}`, import.meta.url), 'utf8')),
  )
  implementation.push(
    await readFile(new URL('../../../assets/codex-process-guard.py', import.meta.url), 'utf8'),
    await readFile(new URL('../../../assets/codex-meta-runner.mjs', import.meta.url), 'utf8'),
  )
  return {
    executable,
    version,
    ...(codeModeHost ? { codeModeHost } : {}),
    ...(caCertificates ? { caCertificates } : {}),
    identity: canonicalDigest({
      implementation,
      experienceImplementation: builtinPolicyImplementationDigest,
      binary: await fileDigest(executable),
      codeModeHost: codeModeHost ? await fileDigest(codeModeHost) : null,
      caCertificates: caCertificates ? await fileDigest(caCertificates) : null,
      version,
      node: process.version,
    }),
  }
}
