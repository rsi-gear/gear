import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { resolveProject } from '../../src/application/project-config.js'
import { ProjectApplication, type ProjectBindings } from '../../src/application/project-service.js'
import { ProjectController } from '../../src/application/project-controller.js'
import { createProjectControlPlane } from '../../src/application/control-plane.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { GearError } from '../../src/domain/errors.js'
import { assertProviderEnvironmentAvailable } from '../../src/adapters/hitch/environment.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { TargetStore, snapshotTarget } from '../../src/adapters/storage/targets.js'
import { requestRefineSkill } from '../../src/adapters/skill/client.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const python = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
beforeEach(() => { vi.stubEnv('GEAR_PYTHON', python) })
const roots: string[] = [], cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
class Provider implements OperationProvider {
  identity = canonicalDigest('project-controller-fixture')
  cancellation = { fixture: 'cancellation-private-canary' }
  capabilities = { seeds: true, temperature: true, subsets: true, idempotentSubmission: true,
    inspect: true, cancel: true, physicalAttemptAccounting: true, evidenceProjection: false, generationBudget: false, hardDollarBudget: false }
  calls: OperationRequest[] = []
  receipts = new Map<string, OperationReceipt>()
  started = Promise.withResolvers<void>()
  block = true
  cancellations = 0
  admissions = 0
  async prepareAdmission() { this.admissions++ }
  async submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    this.calls.push(request)
    const operation = request.operation
    const receipt: OperationReceipt = {
      result: { operation_id: request.operationId, kind: operation.kind, status: 'complete', candidate_id: operation.candidate_id, data: null },
      candidate: null, physicalAttempts: request.slots.length, usage: {}, provenance: null,
      evidence: request.slots.map(slot => ({ candidate_id: operation.candidate_id!, task_id: slot.taskId,
        repetition: slot.repetition, score: 1, status: 'valid', scope: operation.scope, feedback: '' })),
    }
    this.receipts.set(request.operationId, receipt)
    this.started.resolve()
    if (this.block) {
      signal.throwIfAborted()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return receipt
  }
  async inspect(request: OperationRequest) {
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() { this.cancellations++ }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-control-')); roots.push(root)
  const project = join(root, 'p'); await initProject(project)
  const provider = new Provider(), bindings: ProjectBindings = { async provider() { return provider }, async cancellation() { return provider } }
  const app = new ProjectApplication(project, bindings), controller = new ProjectController(app)
  cleanup.push(() => controller.dispose())
  return { root, project, provider, bindings, app, controller }
}

it('explains generation limits and rejects an unsupported Meta before baseline submission', async () => {
  const { app, project, provider } = await fixture()
  const path = join(project, 'gear.yaml')
  await writeFile(path, (await readFile(path, 'utf8')) + '\ngeneration:\n  max_model_requests: 8\n  max_tokens: 1000\n  per_operation: {max_tokens: 250}\n')
  const resolved = await resolveProject(project)
  expect(resolved.config.generation).toEqual({ max_model_requests: 8, max_tokens: 1000, per_operation: { max_tokens: 250 } })
  expect(resolved.origins['generation.per_operation.max_tokens']).toBe('gear.yaml')
  await expect(app.admitRefine({ rounds: 1 })).rejects.toMatchObject({ code: 'generation-budget-unsupported' })
  expect(provider.calls).toHaveLength(0)
})

it('freezes an explicit isolation mode and rejects unknown modes', async () => {
  const { project } = await fixture()
  const file = join(project, 'gear.yaml'), original = await readFile(file, 'utf8')
  await writeFile(file, original + '\nsandbox: {linux_isolation: bubblewrap-only}\n')
  const resolved = await resolveProject(project)
  expect(resolved.config.sandbox).toEqual({ linux_isolation: 'bubblewrap-only' })
  expect(resolved.origins['sandbox.linux_isolation']).toBe('gear.yaml')
  await writeFile(file, original + '\nsandbox: {linux_isolation: disabled}\n')
  await expect(resolveProject(project)).rejects.toMatchObject({ code: 'invalid-config' })
})

it('admits once, rejects conflicting retries, and resumes after controller shutdown without resubmission', async () => {
  const { app, provider, controller } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'same-request') as { run_id: string }
  await provider.started.promise
  const retried = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'same-request') as { run_id: string }
  expect(retried.run_id).toBe(accepted.run_id)
  await expect(controller.call('run.evaluate', { split: 'held_out', limit: 1 }, 'same-request')).rejects.toMatchObject({ code: 'admission-conflict' })
  expect(provider.calls).toHaveLength(1)
  await controller.dispose()
  expect(provider.cancellations).toBe(0)
  expect(await app.store.cancelled(accepted.run_id)).toBe(false)
  expect((await app.store.read(accepted.run_id)).status).toBe('needs_recovery')
  const next = new ProjectController(app); cleanup.push(() => next.dispose())
  await expect(next.call('run.evaluate', { split: 'seed', limit: 1 }, 'same-request')).resolves.toMatchObject({ status: 'needs_recovery' })
  await expect(next.invoke('run.resume', { run_id: accepted.run_id })).resolves.toMatchObject({ status: 'completed', coverage: { physical_attempts: 1 } })
  expect(provider.calls).toHaveLength(1)
  await writeFile(join(app.root, 'gear.yaml'), 'broken project after completion')
  await expect(next.invoke('run.resume', { run_id: accepted.run_id })).resolves.toMatchObject({ status: 'completed' })
})

it('commits the first evaluation reservation atomically with admission even when the acknowledgment is lost', async () => {
  const { app, controller, provider } = await fixture(); provider.block = false
  const create = app.store.create.bind(app.store)
  vi.spyOn(app.store, 'create').mockImplementationOnce(async (...args) => {
    await create(...args)
    throw new Error('lost admission acknowledgment')
  })
  await expect(controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'crash')).rejects.toThrow('lost admission')
  const id = await app.store.latest(), journal = await app.store.read(id)
  expect(journal.operations).toHaveLength(1)
  expect(journal.operations[0]?.reservedAttempts).toBe(1)
  expect(provider.calls).toHaveLength(0)
  await expect(controller.invoke('run.evaluate', { split: 'seed', limit: 1 }, { requestId: 'crash' })).resolves.toMatchObject({ run_id: id, status: 'completed', coverage: { physical_attempts: 1 } })
  expect(provider.calls).toHaveLength(1)
})

it('keeps report accounting readable when frozen Target resources are damaged, and refuses export', async () => {
  const { app, provider } = await fixture(); provider.block = false
  const completed = await app.evaluate({ split: 'seed', limit: 1 })
  expect(completed.changes).toMatchObject({ status: 'available', retained: { files: [] }, nominee: null })
  await rm(join(app.store.root, 'runs', completed.run_id, 'targets', 'anchor', 'prompts', 'system.md'))
  const report = await app.report(completed.run_id)
  expect(report.coverage).toEqual(completed.coverage)
  expect(report.changes).toMatchObject({ status: 'unavailable', error: { code: 'target-identity-mismatch' } })
  await expect(app.export(completed.run_id)).rejects.toMatchObject({ code: 'target-identity-mismatch' })
})

it.each(['missing', 'tampered'])('keeps accounting readable but blocks resume before submission for a %s research object', async (damage) => {
  const { app, provider, controller } = await fixture(); provider.block = false
  const admitted = await app.admitEvaluate({ split: 'seed', limit: 1 })
  const before = await app.report(admitted.runId)
  const bundle = await controller.invoke('run.archive', { run_id: admitted.runId }) as { archive: { packs: string[] } }
  const path = join(app.store.researchStore(admitted.runId).root, 'packs', bundle.archive.packs[0]!.slice(7) + '.json')
  if (damage === 'missing') await rm(path)
  else await writeFile(path, '{}')
  const report = await app.report(admitted.runId)
  expect(report.coverage).toEqual(before.coverage)
  expect(report.research.status).toBe('unavailable')
  await expect(app.resume(admitted.runId)).rejects.toThrow()
  expect(provider.calls).toHaveLength(0)
  expect((await app.store.read(admitted.runId)).status).toBe('ready')
})

it('exports the same verified research archive as the controller and refuses damaged archive exports', async () => {
  const { app, provider, controller } = await fixture(); provider.block = false
  const completed = await app.evaluate({ split: 'seed', limit: 1 })
  const bundle = await controller.invoke('run.archive', { run_id: completed.run_id }) as { archive: { digest: string }; projection: { status: string } }
  expect(bundle.projection.status).toBe('available')
  expect(completed.research).toMatchObject({ status: 'available', digest: bundle.archive.digest })
  const exported = await app.export(completed.run_id)
  await expect(readFile(join(exported.destination, 'cancellation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(completed)).not.toContain('cancellation-private-canary')
  expect(JSON.parse(await readFile(join(exported.destination, 'research-archive.json'), 'utf8'))).toEqual(bundle)
  const path = join(app.store.researchStore(completed.run_id).root, 'snapshots', bundle.archive.digest.slice(7) + '.json')
  await writeFile(path, '{}')
  expect((await app.report(completed.run_id)).research.status).toBe('unavailable')
  await expect(app.export(completed.run_id)).rejects.toMatchObject({ code: 'research-identity-mismatch' })
})

it('can cancel already submitted work despite a damaged research archive, without healing it or resubmitting', async () => {
  const { app, provider, controller } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'cancel-damaged') as { run_id: string }
  await provider.started.promise
  await controller.dispose()
  const prior = await app.store.read(accepted.run_id)
  const bundle = await app.store.researchStore(accepted.run_id).load(prior)
  const path = join(app.store.researchStore(accepted.run_id).root, 'packs', bundle.archive.packs[0]!.slice(7) + '.json')
  await writeFile(path, '{}')
  await app.cancel(accepted.run_id)
  await expect(app.resume(accepted.run_id)).rejects.toMatchObject({ code: 'run-cancelled' })
  const stopped = await app.store.read(accepted.run_id)
  expect(stopped.status).toBe('cancelled')
  expect(stopped.operations).toEqual(prior.operations)
  expect(provider.calls).toHaveLength(1)
  expect(provider.cancellations).toBe(1)
  expect((await app.report(accepted.run_id)).research.status).toBe('unavailable')
  expect(await readFile(path, 'utf8')).toBe('{}')
})

it('shows a rejected nominee separately while exporting the unchanged retained target and identical report', async () => {
  const { app, provider } = await fixture(); provider.block = false
  const completed = await app.evaluate({ split: 'seed', limit: 1 })
  const journal = await app.store.read(completed.run_id)
  const targets = new TargetStore(join(app.store.root, 'runs', completed.run_id), new DshHarnessAdapter(), provider.identity)
  await snapshotTarget(targets.path('anchor'), targets.path('rejected'))
  const rule = join(targets.path('rejected'), 'prompts/system.md')
  await chmod(rule, 0o600)
  await writeFile(rule, 'rejected instruction\n')
  const manifest = await targets.seal('rejected', '', 'anchor')
  journal.candidates.push({ id: 'rejected', parent_id: 'anchor', digest: manifest.digest })
  journal.nomineeId = 'rejected'
  journal.gate = { status: 'rejected', reason: 'fixture protection failure' }
  await app.store.write(journal)
  const report = await app.report(completed.run_id)
  expect(report.changes).toMatchObject({ status: 'available', retained: { files: [] }, nominee: {
    to: { id: 'rejected' }, files: [{ path: 'prompts/system.md', change: 'modified', patch: expect.stringContaining('+rejected instruction') }],
  } })
  const exported = await app.export(completed.run_id)
  expect(JSON.parse(await readFile(join(exported.destination, 'report.json'), 'utf8'))).toEqual(report)
  expect(await readFile(join(exported.destination, 'target/prompts/system.md'), 'utf8')).not.toContain('rejected instruction')
  expect(await app.export(completed.run_id)).toEqual(exported)
})

it('rebuilds only owned interrupted admission directories and excludes them from latest', async () => {
  const { app, controller, provider, bindings } = await fixture(); provider.block = false
  vi.spyOn(bindings, 'provider').mockRejectedValueOnce(new Error('preparation interrupted'))
  await expect(controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'prepare')).rejects.toThrow('preparation interrupted')
  await expect(app.store.latest()).rejects.toMatchObject({ code: 'run-not-found' })
  await expect(controller.invoke('run.evaluate', { split: 'seed', limit: 1 }, { requestId: 'prepare' })).resolves.toMatchObject({ status: 'completed' })
  expect(await readdir(join(app.store.root, 'runs'))).toHaveLength(1)
  const unowned = `run_${'f'.repeat(32)}`
  await mkdir(join(app.store.root, 'runs', unowned))
  await writeFile(join(app.store.root, 'runs', unowned, 'keep'), 'user data')
  await expect(app.admitEvaluate({ split: 'seed' }, unowned)).rejects.toMatchObject({ code: 'admission-conflict' })
  expect(await readFile(join(app.store.root, 'runs', unowned, 'keep'), 'utf8')).toBe('user data')
})

it('keeps socket admissions alive after disconnect, exposes errors, and performs explicit cancellation', async () => {
  const { root, project, bindings, provider } = await fixture()
  const control = await createProjectControlPlane(project, { bindings, socketPath: join(root, 's.sock') })
  cleanup.push(() => control.dispose())
  const client = connect(control.socketPath)
  await new Promise<void>(resolve => client.once('connect', resolve))
  client.write(JSON.stringify({ id: 'lost-wire-reply', method: 'run.evaluate', params: { split: 'seed', limit: 1 } }) + '\n')
  client.destroy()
  await provider.started.promise
  const accepted = await requestRefineSkill(control.socketPath, { id: 'lost-wire-reply', method: 'run.evaluate', params: { split: 'seed', limit: 1 } }) as { run_id: string }
  await expect(requestRefineSkill(control.socketPath, { method: 'run.report', params: { run_id: accepted.run_id } })).resolves.toMatchObject({ status: 'running' })
  await expect(requestRefineSkill(control.socketPath, { id: 'lost-wire-reply', method: 'run.evaluate', params: { split: 'held_out' } })).rejects.toMatchObject({ code: 'admission-conflict' })
  await requestRefineSkill(control.socketPath, { method: 'run.cancel', params: { run_id: accepted.run_id } })
  await expect.poll(async () => (await control.application.store.read(accepted.run_id)).status).toBe('cancelled')
  expect(provider.cancellations).toBe(1)
  expect(provider.calls).toHaveLength(1)
  expect(await control.application.store.cancelled(accepted.run_id)).toBe(true)
})

it('validates the same command parameters in foreground and Skill calls', async () => {
  const { controller } = await fixture()
  for (const call of [controller.call.bind(controller), controller.invoke.bind(controller)]) {
    await expect(call('run.evaluate', { split: 'sead' })).rejects.toMatchObject({ code: 'explicit-split-required' })
    await expect(call('run.refine', { rounds: 0 })).rejects.toMatchObject({ code: 'invalid-command-params' })
    await expect(call('run.refine', { round: 1 })).rejects.toMatchObject({ code: 'unknown-command-params' })
    await expect(call('config.explain', { arbitrary: true })).rejects.toMatchObject({ code: 'unknown-command-params' })
  }
})

it('persists startup failures so a new controller can explain and recover them', async () => {
  const { app, controller, provider, bindings } = await fixture(); provider.block = false
  const { runId } = await app.admitEvaluate({ split: 'seed', limit: 1 })
  vi.spyOn(bindings, 'provider').mockRejectedValueOnce(new Error('profile unavailable during resume'))
  await expect(controller.invoke('run.resume', { run_id: runId })).rejects.toMatchObject({ code: 'run-execution-failed', details: { run_id: runId } })
  const next = new ProjectController(app); cleanup.push(() => next.dispose())
  await expect(next.call('run.report', { run_id: runId })).resolves.toMatchObject({ status: 'needs_recovery', error: { message: 'profile unavailable during resume' } })
  const recovered = await next.invoke('run.resume', { run_id: runId })
  expect(recovered).toMatchObject({ status: 'completed', coverage: { physical_attempts: 1 } })
  expect(recovered).not.toHaveProperty('error')
})

it('persists safe provider probe diagnostics through startup failure, report and CLI serialization', async () => {
  const { app, controller, provider, bindings } = await fixture(); provider.block = false
  const { runId } = await app.admitEvaluate({ split: 'seed', limit: 1 })
  const diagnostics = { schema_version: '1', probes: [{ probe: 'docker_info', attempt: 1, stage: 'command', outcome: 'timed_out', elapsed_ms: 10_000, exit_code: null, signal: 'SIGTERM' }] }
  let failure: GearError | undefined
  try {
    assertProviderEnvironmentAvailable({ schema_version: '2', host_platform: 'linux-x64',
      harbor: { status: 'available', version: '0.21.0', executable_digest: canonicalDigest('harbor') },
      docker: { status: 'unavailable', version: null, executable_digest: null, engine_id: null, os: null, architecture: null, error: 'private-token' },
      buildx: { status: 'unavailable', version: null }, sandbox: { status: 'unverified' },
    }, diagnostics)
  } catch (error) { failure = error as GearError }
  expect(failure).toMatchObject({ code: 'provider-environment-unavailable' })
  vi.spyOn(bindings, 'provider').mockRejectedValueOnce(failure)
  await expect(controller.invoke('run.resume', { run_id: runId })).rejects.toMatchObject({ code: failure!.code, message: failure!.message, details: { run_id: runId } })
  const next = new ProjectController(app); cleanup.push(() => next.dispose())
  const report = await next.call('run.report', { run_id: runId })
  const persisted = (await app.store.read(runId)).failure
  expect(report).toMatchObject({ status: 'needs_recovery', error: { code: failure!.code, message: failure!.message } })
  expect(persisted?.message).toBe(failure!.message)
  expect(JSON.parse(persisted!.message.split('; diagnostics=')[1]!)).toEqual(diagnostics)
  expect(JSON.parse(JSON.stringify(failure))).toMatchObject({ code: failure!.code, message: persisted!.message })
  expect(JSON.stringify(report)).not.toContain('private-token')
  expect(provider.calls).toHaveLength(0)
})

it.each(['project', 'benchmark', 'target', 'provider'])('stops submitted work after %s changes without reconnecting the execution provider', async damage => {
  const { app, provider, controller, bindings, project } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'cancel-drift') as { run_id: string }
  await provider.started.promise
  await controller.dispose()
  const prior = await app.store.read(accepted.run_id), directory = join(project, '.gear/runs', accepted.run_id)
  if (damage === 'target') await rm(join(directory, 'targets'), { recursive: true })
  else if (damage !== 'provider') await writeFile(join(directory, damage + '.json'), '{}')
  bindings.provider = vi.fn(async () => { throw new Error('execution preparation must not run during cancellation') })
  await app.cancel(accepted.run_id)
  await expect(app.resume(accepted.run_id)).rejects.toMatchObject({ code: 'run-cancelled' })
  expect(bindings.provider).not.toHaveBeenCalled()
  const stopped = await app.store.read(accepted.run_id)
  expect(stopped.status).toBe('cancelled')
  expect(stopped.operations).toEqual(prior.operations)
  expect(stopped.physicalAttempts).toBe(prior.physicalAttempts)
  expect(provider.cancellations).toBe(1)
  expect(provider.calls).toHaveLength(1)
})
it('cancels an unsubmitted run without requiring any prepared runtime or provider snapshot', async () => {
  const { app, bindings, project, provider } = await fixture()
  const accepted = await app.admitEvaluate({ split: 'seed', limit: 1 })
  await rm(join(project, '.gear/runs', accepted.runId, 'benchmark.json'))
  bindings.provider = vi.fn(async () => { throw new Error('must not prepare') })
  await app.cancel(accepted.runId)
  await expect(app.resume(accepted.runId)).rejects.toMatchObject({ code: 'run-cancelled' })
  expect((await app.store.read(accepted.runId)).status).toBe('cancelled')
  expect(bindings.provider).not.toHaveBeenCalled()
  expect(provider.calls).toHaveLength(0)
  expect(provider.cancellations).toBe(0)
})

it('keeps an unverified cancellation snapshot unconfirmed, then retries with restored original bytes', async () => {
  const { app, provider, controller, project } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'cancel-snapshot') as { run_id: string }
  await provider.started.promise; await controller.dispose()
  const prior = await app.store.read(accepted.run_id), path = join(project, '.gear/runs', accepted.run_id, 'cancellation.json')
  const bytes = await readFile(path)
  await writeFile(path, '{}')
  await app.cancel(accepted.run_id)
  await expect(app.resume(accepted.run_id)).rejects.toMatchObject({ code: 'cancellation-unconfirmed', details: { retryable: true } })
  const unknown = await app.store.read(accepted.run_id)
  expect(unknown.status).toBe('needs_recovery')
  expect(unknown.failure?.code).toBe('cancellation-unconfirmed')
  expect(unknown.operations).toEqual(prior.operations)
  expect(provider.cancellations).toBe(0)
  await writeFile(path, bytes)
  await expect(app.resume(accepted.run_id)).rejects.toMatchObject({ code: 'run-cancelled' })
  expect(provider.cancellations).toBe(1)
  expect(provider.calls).toHaveLength(1)
})
it('a new foreground controller confirms cancellation of stopped-owner work without requiring run.resume', async () => {
  const { app, provider, controller, bindings } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'cancel-owner') as { run_id: string }
  await provider.started.promise; await controller.dispose()
  bindings.provider = vi.fn(async () => { throw new Error('must not reconnect for execution') })
  const next = new ProjectController(app)
  cleanup.push(() => next.dispose())
  expect(await next.invoke('run.cancel', { run_id: accepted.run_id })).toEqual({ run_id: accepted.run_id, cancellation: 'confirmed' })
  expect((await app.store.read(accepted.run_id)).status).toBe('cancelled')
  expect(provider.cancellations).toBe(1)
  expect(bindings.provider).not.toHaveBeenCalled()
})

it('interrupts an in-progress recovery connection while independently stopping its old submitted work', async () => {
  const { app, provider, controller, bindings } = await fixture()
  const accepted = await controller.call('run.evaluate', { split: 'seed', limit: 1 }, 'cancel-reconnecting') as { run_id: string }
  await provider.started.promise; await controller.dispose()
  const preparing = Promise.withResolvers<void>(), interrupted = Promise.withResolvers<void>()
  bindings.provider = async (_context, signal) => {
    preparing.resolve()
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { interrupted.resolve(); reject(signal!.reason) }, { once: true }))
  }
  const next = new ProjectController(app)
  cleanup.push(() => next.dispose())
  await next.call('run.resume', { run_id: accepted.run_id })
  await preparing.promise
  await next.call('run.cancel', { run_id: accepted.run_id })
  await interrupted.promise
  await expect.poll(async () => (await app.store.read(accepted.run_id)).status).toBe('cancelled')
  expect(provider.cancellations).toBe(1)
  expect(provider.calls).toHaveLength(1)
})

it('prepares native control only during admission, never preview or resume', async () => {
  const { app, provider } = await fixture()
  await app.previewRefine()
  expect(provider.admissions).toBe(0)
  const accepted = await app.admitEvaluate({ split: 'seed', limit: 1 })
  expect(provider.admissions).toBe(1)
  provider.block = false
  await app.resume(accepted.runId)
  expect(provider.admissions).toBe(1)
})
