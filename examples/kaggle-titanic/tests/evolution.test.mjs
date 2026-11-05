import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateWorkspaceManager } from '../../../lib/candidate/workspace.js'
import { HarnessBuilder } from '../../../lib/harness/builder.js'
import { SubprocessHarnessCompiler } from '../../../lib/harness/compiler.js'
import { bootstrap } from '../prepare.mjs'
import { selectedCandidate } from '../finalize.mjs'
import { command, hash } from '../common.mjs'

// This exercises the production workspace/compiler/sealing path without a model or training job.
test('Python candidate A and inherited config candidate B seal through the existing Gear builder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gear-kaggle-evolution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = await bootstrap(join(root, 'target'))
  const manager = new CandidateWorkspaceManager({ repositoryPath: project.targetRepository, targetRoot: 'harness',
    rootForEvolution: id => join(root, 'workspaces', id), maxFiles: 10, maxBytes: 1024 * 1024, maxDiffBytes: 1024 * 1024 })
  const compiler = new SubprocessHarnessCompiler({ command: process.execPath, args: [join(project.targetRepository, 'fixed/check.mjs')],
    env: { PATH: process.env.PATH ?? '' }, timeoutMs: 30000, sandboxMode: 'disabled', targetRoot: 'harness' })
  const builder = new HarnessBuilder({ repositoryPath: project.targetRepository, targetRoot: 'harness', dshBaseRef: project.dshBaseRef,
    toolchainRef: 'kaggle-dsh-cpu-v1', sandboxProfileRef: 'kaggle-chroot-v1', compiler })
  await manager.initialize(); await builder.initialize()
  const signal = new AbortController().signal
  const evolve = async (name, parent, mutate) => {
    const handle = await manager.create({ evolutionId: 'kaggle-test', roundId: name, parentHarnessRef: parent.ref,
      parentHarnessDigest: parent.digest ?? parent.manifestDigest }, signal)
    try {
      await mutate(handle)
      const check = await builder.checkWorkspace(handle, signal)
      assert.equal(check.ok, true); assert.equal(check.runtime.load.status, 'not_checked')
      const sealed = await manager.seal(handle.workspaceId, signal)
      manager.markFinalizing(handle.workspaceId)
      await manager.verifySealed(handle.workspaceId, sealed, signal)
      const candidate = await builder.finalizeWorkspace(handle, sealed, signal)
      await manager.markCommitted(handle.workspaceId)
      await builder.verifySealedCandidate({ commitOid: candidate.ref, treeOid: candidate.treeOid,
        manifestDigest: candidate.digest, immutableRef: candidate.immutableRef, patchDigest: sealed.patchDigest })
      assert.equal((await builder.readManifest(candidate.ref)).digest, candidate.digest)
      assert.equal((await selectedCandidate(project, candidate.ref, candidate.digest)).digest, candidate.digest)
      return candidate
    } finally { await manager.dispose(handle.workspaceId) }
  }
  const originalFeatures = await readFile(join(project.targetRepository, 'harness/workflows/titanic/features.py'), 'utf8')
  const changedFeatures = originalFeatures.replace("    result['IsAlone']", "    result['Fare'] = result['Fare'] / result['FamilySize']\n    result['IsAlone']")
  const a = await evolve('candidate-a', project.initialChampion, handle => writeFile(join(handle.targetPath, 'workflows/titanic/features.py'), changedFeatures))
  const b = await evolve('candidate-b', a, async handle => {
    assert.equal(await readFile(join(handle.targetPath, 'workflows/titanic/features.py'), 'utf8'), changedFeatures)
    await writeFile(join(handle.targetPath, 'workflows/titanic/model.json'), '{"C":2,"max_iter":1000}\n')
  })
  assert.equal(a.manifest.parentRef, project.initialChampion.ref)
  assert.equal(b.manifest.parentRef, a.ref)
  assert.notEqual(a.digest, b.digest)
  for (const candidate of [a, b]) assert.equal(candidate.manifest.artifacts.find(entry => entry.path === 'workflows/titanic/features.py').digest, hash(changedFeatures))
  assert.equal((await builder.readHarnessFile(b.ref, 'workflows/titanic/model.json')).content, '{"C":2,"max_iter":1000}\n')
  assert.equal(await readFile(join(project.targetRepository, 'harness/workflows/titanic/features.py'), 'utf8'), originalFeatures)

  // A malicious inherited commit can leave the harness digest intact. The fixed checker
  // still compares the whole tree to dshBaseRef before any descendant can be sealed.
  const poisoned = join(root, 'poisoned-parent')
  await command('git', ['worktree', 'add', '--detach', poisoned, b.ref], { cwd: project.targetRepository })
  try {
    await writeFile(join(poisoned, 'fixed/runner.py'), '# inherited bypass\n')
    await command('git', ['add', 'fixed/runner.py'], { cwd: poisoned })
    await command('git', ['commit', '--no-gpg-sign', '-m', 'Poisoned inherited carrier'], { cwd: poisoned })
    const ref = await command('git', ['rev-parse', 'HEAD'], { cwd: poisoned })
    await assert.rejects(evolve('candidate-c', { ref, digest: b.digest }, handle =>
      writeFile(join(handle.targetPath, 'workflows/titanic/model.json'), '{"C":3,"max_iter":1000}\n')), /fixed carrier file changed/)
  } finally { await command('git', ['worktree', 'remove', '--force', poisoned], { cwd: project.targetRepository }) }
})
