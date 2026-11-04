import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { ArtifactOperations } from '../../src/adapters/storage/artifacts.js'
import { WorkspaceOperations } from '../../src/adapters/storage/workspaces.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import type { Operation } from '../../src/domain/algorithm-wire.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { workspaceResult } from '../../src/domain/workspaces.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const request = (kind: Operation['kind'], payload: Operation['payload'], candidate: string | null = null): OperationRequest => {
  const operation: Operation = { kind, parent_id: 'anchor', candidate_id: candidate, task_ids: [], scope: 'global', rationale: 'artifact test', payload }
  return { operationId: canonicalDigest(operation), runId: 'run', generation: 1, operation, partition: 'seed', repetitions: 1, slots: [], evidence: [] }
}
it('reads exact files and produces a real draft diff after atomic multi-file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-artifact-')); roots.push(root)
  const targets = new TargetStore(root, new PiHarnessAdapter(), canonicalDigest('runtime'))
  await targets.adapter.prepare(targets.path('anchor'))
  const base = { candidate_id: 'anchor', digest: (await targets.seal('anchor', 'base')).digest }
  const artifacts = new ArtifactOperations(targets), workspaces = new WorkspaceOperations(targets)
  const listing = await artifacts.submit(request('artifact_list', { gear_artifact_v1: { source: base } }))
  expect(listing.result.data).toMatchObject({ resources: expect.arrayContaining([expect.objectContaining({ path: 'AGENTS.md' })]), mutation_policy: { writableRoots: expect.arrayContaining(['AGENTS.md']) } })
  const reading = request('artifact_read', { gear_artifact_v1: { source: base, paths: ['AGENTS.md'] } })
  const read = await artifacts.submit(reading)
  expect(read.result.data).toMatchObject({ files: { 'AGENTS.md': expect.stringContaining('Follow the task') } })
  expect(await artifacts.inspect(reading)).toEqual(read)
  await expect(artifacts.submit(request('artifact_read', { gear_artifact_v1: { source: base, paths: ['../private'] } }))).rejects.toMatchObject({ code: 'artifact-path-unavailable' })
  const opened = workspaceResult((await workspaces.submit(request('workspace_open', { gear_workspace_v1: { output_id: 'draft', base_digest: base.digest } }))).result)!
  const applied = workspaceResult((await workspaces.submit(request('workspace_apply', {
    gear_workspace_v1: { source: opened as never, output_id: 'updated' }, edits: {
      'AGENTS.md': 'revised prompt', '.pi/skills/new/SKILL.md': '# new skill', '.pi/settings.json': null,
    },
  }))).result)!
  expect(await readdir(join(root, 'targets'))).toEqual(['anchor'])
  const diff = (await artifacts.submit(request('artifact_diff', { gear_artifact_v1: { source: base, other: applied as never } }))).result.data
  expect(diff).toMatchObject({ omitted_patches: 0, files: expect.arrayContaining([
    expect.objectContaining({ path: 'AGENTS.md', change: 'modified', patch: expect.stringContaining('+revised prompt') }),
    expect.objectContaining({ path: '.pi/settings.json', change: 'removed' }),
    expect.objectContaining({ path: '.pi/skills/new/SKILL.md', change: 'added' }),
  ]) })
  expect(await readFile(join(targets.path('anchor'), '.pi/settings.json'), 'utf8')).toBe('{}\n')
  await expect(workspaces.submit(request('workspace_apply', { gear_workspace_v1: { source: applied as never, output_id: 'escape' }, edits: { '../private': 'secret' } }))).rejects.toThrow()
  await chmod(join(targets.path('anchor'), 'AGENTS.md'), 0o600); await writeFile(join(targets.path('anchor'), 'AGENTS.md'), 'tampered')
  await expect(artifacts.submit(reading)).rejects.toMatchObject({ code: 'target-identity-mismatch' })
  await expect(artifacts.tree(base)).rejects.toMatchObject({ code: 'target-identity-mismatch' })
})
