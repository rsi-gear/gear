import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { WorkspaceOperations, WorkspaceStore } from '../../src/adapters/storage/workspaces.js'
import { TargetStore, snapshotTarget } from '../../src/adapters/storage/targets.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import type { Operation, SearchView } from '../../src/domain/algorithm-wire.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { workspaceResult, type WorkspaceRef } from '../../src/domain/workspaces.js'
import { validateDecision } from '../../src/runtime/decision-validation.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function request(operation: Partial<Operation>): OperationRequest {
  const op: Operation = { kind: 'workspace_open', candidate_id: null, parent_id: 'anchor',
    task_ids: [], scope: 'global', rationale: 'workspace test', payload: null, ...operation }
  return { operationId: canonicalDigest(op), runId: 'run', generation: 1, operation: op,
    partition: 'seed', repetitions: 1, slots: [], evidence: [] }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-workspaces-')); roots.push(root)
  const targets = new TargetStore(root, new PiHarnessAdapter(), canonicalDigest('runtime'))
  await targets.adapter.prepare(targets.path('anchor'))
  const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'base')).digest }
  const service = new WorkspaceOperations(targets)
  const opening = request({ payload: { gear_workspace_v1: { output_id: 'draft0', base_digest: anchor.digest } } })
  const opened = await service.submit(opening)
  const ref = workspaceResult(opened.result)!
  async function revision(id: string, source: WorkspaceRef, settings = '{}') {
    const path = join(root, id)
    await snapshotTarget(service.store.files(source), path)
    await chmod(join(path, 'AGENTS.md'), 0o600); await writeFile(join(path, 'AGENTS.md'), `edited ${id}`)
    await chmod(join(path, '.pi/settings.json'), 0o600); await writeFile(join(path, '.pi/settings.json'), settings)
    const edit = request({ kind: 'workspace_edit', payload: { gear_workspace_v1: { output_id: id, source: source as never } } })
    return { edit, ref: await service.store.save(edit, path) }
  }
  return { root, targets, anchor, service, opening, opened, ref, revision }
}
it('preserves immutable revisions and only creates a candidate on seal, replaying local side effects', async () => {
  const f = await fixture(), second = await f.revision('draft1', f.ref), third = await f.revision('draft2', second.ref)
  expect(await readdir(join(f.root, 'targets'))).toEqual(['anchor'])
  expect(await readFile(join(f.service.store.files(second.ref), 'AGENTS.md'), 'utf8')).toBe('edited draft1')
  expect(await readFile(join(f.service.store.files(third.ref), 'AGENTS.md'), 'utf8')).toBe('edited draft2')
  const seal = request({ kind: 'workspace_seal', candidate_id: 'child', payload: { gear_workspace_v1: { source: third.ref as never } } })
  const sealed = await f.service.submit(seal)
  expect(sealed.candidate?.parent_id).toBe('anchor')
  expect(await readdir(join(f.root, 'targets'))).toEqual(['anchor', 'child'])
  // Simulate interruption after candidate and closure publication, before its receipt reached disk.
  await rm(join(f.root, 'workspaces/operations', seal.operationId.slice(7), 'receipt.json'))
  await mkdir(join(f.root, 'targets/.workspace-seal-abandoned'))
  expect(await new WorkspaceOperations(f.targets).inspect(seal)).toBeNull()
  expect(await new WorkspaceOperations(f.targets).submit(seal)).toEqual(sealed)
  expect(await f.service.submit(f.opening)).toEqual(f.opened)
  await expect(f.service.store.assertOpen(second.ref, second.edit)).rejects.toMatchObject({ code: 'workspace-closed' })
  const changed = { ...f.opening, generation: 2 }
  await expect(f.service.submit(changed)).rejects.toMatchObject({ code: 'workspace-operation-conflict' })
})
it('records an invalid seal without a candidate and allows repairing the still-open draft', async () => {
  const f = await fixture(), invalid = await f.revision('invalid', f.ref, '[]')
  const seal = request({ kind: 'workspace_seal', candidate_id: 'bad', payload: { gear_workspace_v1: { source: invalid.ref as never } } })
  expect((await f.service.submit(seal)).result.status).toBe('failed')
  expect(await readdir(join(f.root, 'targets'))).toEqual(['anchor'])
  await f.service.store.assertOpen(invalid.ref, invalid.edit)
  const repaired = await f.revision('repaired', invalid.ref)
  const good = request({ kind: 'workspace_seal', candidate_id: 'good', payload: { gear_workspace_v1: { source: repaired.ref as never } } })
  expect((await f.service.submit(good)).candidate?.id).toBe('good')
})
it('can discard without deleting evidence and fences every revision of the draft', async () => {
  const f = await fixture(), edited = await f.revision('draft1', f.ref)
  const discard = request({ kind: 'workspace_discard', payload: { gear_workspace_v1: { source: edited.ref as never } } })
  await f.service.submit(discard)
  await expect(f.service.store.assertOpen(f.ref, f.opening)).rejects.toMatchObject({ code: 'workspace-closed' })
  expect(await new WorkspaceStore(f.root).verify(edited.ref)).toMatchObject({ digest: edited.ref.digest })
  expect(await readdir(join(f.root, 'targets'))).toEqual(['anchor'])
  await expect((await configuredCancellation({ version: 1, kind: 'composite', evaluation: null, meta: null })).cancel(discard)).resolves.toBeUndefined()
})
it('rejects forged, unknown and colliding revisions at admission and detects altered bytes', async () => {
  const f = await fixture()
  const view = { run_id: 'run', candidates: [f.anchor], tasks: [], completed: [f.opened.result],
    budget: { candidates_remaining: 1 } } as unknown as SearchView
  const edit = request({ kind: 'workspace_edit', payload: { gear_workspace_v1: { source: f.ref as never, output_id: 'next' } } }).operation
  const decision = (ops: Operation[]) => ({ state: { version: 1 as const, data: {} }, operations: ops, reason: 'test' })
  expect(() => validateDecision(view, decision([edit]))).not.toThrow()
  expect(() => validateDecision(view, decision([edit, { ...edit, payload: { gear_workspace_v1: { source: f.ref as never, output_id: 'other' } } }]))).toThrow('mutations overlap')
  const otherRoot = { ...edit, payload: { gear_workspace_v1: { source: { ...f.ref, root_id: 'other' }, output_id: 'next' } } }
  expect(() => validateDecision(view, decision([edit, otherRoot]))).toThrow('output revisions overlap')
  await expect(f.service.store.verify({ ...f.ref, digest: canonicalDigest('forged') })).rejects.toThrow('revision changed')
  const file = join(f.service.store.files(f.ref), 'AGENTS.md')
  await chmod(file, 0o600); await writeFile(file, 'changed after freezing')
  await expect(f.service.store.verify(f.ref)).rejects.toThrow('revision changed')
})
