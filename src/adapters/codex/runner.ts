import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { validateAlgorithmWire } from '../../domain/algorithm-schema.js'
import { fileLockHeld, withFileLock } from '../storage/file-lock.js'
import { publishFile } from '../storage/atomic.js'
import {
  capabilities,
  codexPassEnvNames,
  validateInput,
  type CodexInput,
  type CodexJob,
} from './contracts.js'
import { describeCodex } from './identity.js'
import { executeJob, exists } from './execution.js'
import { dedicatedWorkerShutdown, type CodexWorkerLifecycle } from './cleanup.js'
import { initializeJournal, registerOperation, stateLost, withJournal } from './journal.js'

const workerEntry = fileURLToPath(new URL('../../../assets/codex-meta-runner.mjs', import.meta.url))
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

async function inspection(directory: string, digest: string) {
  const receipt = join(directory, 'receipt.json')
  if (await exists(receipt)) {
    const value = await readJson(receipt)
    validateAlgorithmWire('OperationReceipt', value)
    if ((value as { provenance?: { input_digest?: string } }).provenance?.input_digest !== digest)
      throw stateLost()
    return { state: 'complete' as const, receipt: value }
  }
  return {
    state: (await fileLockHeld(join(directory, 'execution.lock')))
      ? ('running' as const)
      : ('unknown' as const),
  }
}

export async function codexOperation(raw: unknown): Promise<unknown> {
  const input = validateInput(raw)
  if (input.action === 'describe') {
    const runtime = await describeCodex(input.configuration)
    return {
      version: 1,
      identity: runtime.identity,
      capabilities,
      admission: true,
      runtime: { version: runtime.version },
    }
  }
  if (input.action === 'prepare_admission') {
    const runtime = await describeCodex(input.configuration)
    if (runtime.identity !== input.implementationIdentity)
      throw new GearError('codex-identity-changed', 'Codex changed after the provider handshake')
    await initializeJournal(input)
    return { prepared: true }
  }
  const bound = input as CodexInput & { request: NonNullable<CodexInput['request']> }
  const directory = join(input.context.directory, bound.request.operationId.slice(7))
  const digest = canonicalDigest({
    request: input.request,
    configuration: input.configuration,
    context: input.context,
    implementationIdentity: input.implementationIdentity,
  })
  const jobPath = join(directory, 'job.json')
  return withJournal(input, async (journal) => {
    const entry = journal.operations[bound.request.operationId]
    if (entry && entry.digest !== digest)
      throw new GearError('codex-operation-conflict', 'Operation ID was reused with different inputs')
    if (!entry && (await exists(directory))) throw stateLost()
    let job: CodexJob | undefined
    if (await exists(jobPath)) {
      job = (await readJson(jobPath)) as CodexJob
      if (job.digest !== digest)
        throw new GearError('codex-operation-conflict', 'Operation ID was reused with different inputs')
    }
    if (await exists(join(directory, 'cancel.json'))) {
      const tombstone = (await readJson(join(directory, 'cancel.json'))) as { digest: string }
      if (tombstone.digest !== digest)
        throw new GearError('codex-operation-conflict', 'Cancelled operation has different inputs')
    }
    if (entry && entry.state !== 'fenced' && !job) throw stateLost()
    if (input.action === 'inspect')
      return job ? inspection(directory, digest) : { state: 'not_submitted' as const }
    if (input.action === 'cancel') {
      if (!entry) await registerOperation(input, journal, { digest, state: 'fenced' })
      await publishFile(join(directory, 'cancel.json'), JSON.stringify({ digest }), { immutable: true })
      // The ledger proves a pre-start fence. An admitted operation always needs a
      // durable receipt and a released execution lock, even if started.json is lost.
      return entry && entry.state !== 'fenced' ? { cancelling: true as const } : { cancelled: true }
    }
    if (!job) {
      const runtime = await describeCodex(input.configuration)
      if (runtime.identity !== input.implementationIdentity)
        throw new GearError('codex-identity-changed', 'Codex changed after the provider handshake')
      if (!entry) await registerOperation(input, journal, { digest, state: 'admitted' })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (entry?.state === 'fenced')
        await publishFile(join(directory, 'cancel.json'), JSON.stringify({ digest }), { immutable: true })
      job = { version: 1, input: { ...bound, action: 'submit' }, digest, identity: runtime.identity }
      await publishFile(jobPath, JSON.stringify(job), { immutable: true })
      // The intent precedes spawn. A crash in that gap remains unknown, never a blind retry.
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' }
      for (const key of [...codexPassEnvNames, 'GEAR_LOCK_PYTHON'])
        if (process.env[key] !== undefined) env[key] = process.env[key]
      const child = spawn(process.execPath, [workerEntry, '--worker', directory], {
        env,
        detached: true,
        stdio: 'ignore',
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
    }
    return { pending: true }
  })
    .catch((error: unknown) => {
      if (
        input.action === 'inspect' &&
        error instanceof GearError &&
        error.code === 'codex-state-unavailable'
      )
        return { state: 'unknown' as const }
      throw error
    })
    .then(async (result) => {
      if ('cancelling' in result) {
        const deadline = Date.now() + 5000
        for (;;) {
          const held = await fileLockHeld(join(directory, 'execution.lock'))
          if (!held && (await exists(join(directory, 'receipt.json')))) {
            await inspection(directory, digest)
            return { cancelled: true }
          }
          if (Date.now() >= deadline)
            throw new GearError(
              'codex-cancellation-unconfirmed',
              'Worker termination has no durable confirmation',
            )
          await delay(100)
        }
      }
      if (!('pending' in result)) return result
      // Waiting for acknowledgment is separate from owning the external operation.
      for (let index = 0; ; index++) {
        if (await exists(join(directory, 'receipt.json')))
          return ((await inspection(directory, digest)) as { receipt: unknown }).receipt
        if (index > 20 && !(await fileLockHeld(join(directory, 'execution.lock')))) {
          // The worker may publish and release between the two observations.
          if (await exists(join(directory, 'receipt.json')))
            return ((await inspection(directory, digest)) as { receipt: unknown }).receipt
          throw new GearError(
            'codex-result-unknown',
            'Meta result is unknown; inspect and reconcile before retrying',
          )
        }
        await delay(250)
      }
    })
}

export async function runCodexWorker(directory: string, worker?: CodexWorkerLifecycle): Promise<void> {
  const root = await realpath(directory)
  await withFileLock(join(root, 'execution.lock'), async () => {
    if (await exists(join(root, 'receipt.json'))) return
    // Even an accidental duplicate worker cannot repeat an already-started model call.
    if (await exists(join(root, 'started.json'))) return
    const job = (await readJson(join(root, 'job.json'))) as CodexJob
    validateInput(job.input)
    if (
      (await realpath(resolve(job.input.context.directory, job.input.request.operationId.slice(7)))) !==
        root ||
      job.digest !==
        canonicalDigest({
          request: job.input.request,
          configuration: job.input.configuration,
          context: job.input.context,
          implementationIdentity: job.input.implementationIdentity,
        })
    )
      throw new GearError('codex-job-invalid', 'Operation journal identity does not match its directory')
    const execute = await withJournal(job.input, async (journal) => {
      const entry = journal.operations[job.input.request.operationId]
      if (!entry || entry.digest !== job.digest) throw stateLost()
      if (entry.state === 'started') return false
      worker?.assertOwnership()
      if (entry.state === 'fenced')
        await publishFile(join(root, 'cancel.json'), JSON.stringify({ digest: job.digest }), {
          immutable: true,
        })
      else await registerOperation(job.input, journal, { digest: job.digest, state: 'started' })
      await publishFile(
        join(root, 'started.json'),
        JSON.stringify({ digest: job.digest, pid: process.pid }),
        {
          immutable: true,
        },
      )
      return true
    })
    if (execute) await executeJob(job, root, worker)
  })
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 2 && argv[0] === '--worker') {
    const shutdown = await dedicatedWorkerShutdown()
    let code = 1
    try {
      await runCodexWorker(argv[1]!, shutdown)
      code = 0
    } finally {
      // The normal exit is outside withFileLock; the watchdog covers a stuck lock keeper.
      shutdown.exit(code)
    }
    return
  }
  if (argv.length) throw new Error('gear-meta-codex reads one version 1 operation request from stdin')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16 * 1024 * 1024) throw new Error('Meta request exceeds 16 MiB')
    chunks.push(buffer)
  }
  // Pipe chunks can split a UTF-8 character; decode only after reassembling bytes.
  const input = Buffer.concat(chunks, bytes).toString('utf8')
  process.stdout.write(`${JSON.stringify(await codexOperation(JSON.parse(input)))}\n`)
}
