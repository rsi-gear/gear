import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactPins, hitchPreparedArtifacts, assertStablePreparedArtifacts } from '../../src/adapters/hitch/artifacts.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { isPinnedHarnessReference } from '../../src/adapters/hitch/reference.js'

function fixture() {
  const expected = { evalId: 'eval_' + 'a'.repeat(32), harnessRef: 'pi@version:0.84.1', revisionIdentity: canonicalDigest('revision'), provider: 'local-docker', taskIds: ['a', 'b'] }
  const rows = expected.taskIds.map((task, i) => {
    const platform = i ? 'linux-x64' : 'linux-arm64'
    return { artifact_id: canonicalDigest(platform), artifact_integrity: canonicalDigest(['tree', platform]), entrypoint_integrity: canonicalDigest(['entry', platform]),
      harness_id: 'pi', revision_identity: expected.revisionIdentity, platform, node_version: 'v22.23.0', source_type: 'npm', storage: 'harbor-artifact-cache-v2',
      task_ids: [task], runtime_contract: { docker_platform: i ? 'linux/amd64' : 'linux/arm64', artifact_platform: platform, node_version: 'v22.23.0' } }
  })
  const inspection = { plan: { prepared_artifacts: structuredClone(rows) }, result: { prepared_artifacts: structuredClone(rows) }, execution_plan: {
    membership: 'known', work_items: rows.map(row => ({ schema_version: '1', eval_id: expected.evalId, backend: 'harbor', provider: expected.provider, logical_attempt: 1,
      opaque_membership: false, task_ids: row.task_ids, artifact_id: row.artifact_id, runtime_contract: row.runtime_contract })) } }
  return { inspection, expected }
}
it('retains per-task artifact evidence across multiple platforms and ignores assignment order', () => {
  const { inspection, expected } = fixture()
  const result = hitchPreparedArtifacts(inspection, expected)
  inspection.result.prepared_artifacts.reverse()
  inspection.result.prepared_artifacts[0]!.task_ids.reverse()
  inspection.execution_plan.work_items.reverse()
  expect(hitchPreparedArtifacts(inspection, expected)).toEqual(result)
  expect(result.map(row => [row.task_id, row.artifact.platform])).toEqual([['a', 'linux-arm64'], ['b', 'linux-x64']])
})
it.each(['deepseek', 'pi'])('classifies %s Git artifacts by the selector when repository paths contain @version:', harness => {
  const { inspection, expected } = fixture()
  const source = pathToFileURL(join(tmpdir(), 'runtime@version:custom')).href
  expected.harnessRef = `${harness}@git+${source}#${'a'.repeat(40)}`
  expect(isPinnedHarnessReference(expected.harnessRef)).toBe(true)
  for (const section of [inspection.plan, inspection.result]) {
    for (const row of section.prepared_artifacts) {
      row.harness_id = harness
      row.source_type = 'git'
    }
  }
  expect(hitchPreparedArtifacts(inspection, expected)).toHaveLength(2)
  for (const section of [inspection.plan, inspection.result]) {
    for (const row of section.prepared_artifacts) row.source_type = 'npm'
  }
  expect(() => hitchPreparedArtifacts(inspection, expected)).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
})
it.each(['plan', 'result'] as const)('rejects duplicate/missing task assignments in %s', section => {
  const { inspection, expected } = fixture()
  inspection[section].prepared_artifacts[1]!.task_ids = ['a']
  expect(() => hitchPreparedArtifacts(inspection, expected)).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
})
it('rejects duplicate work coverage and does not let a missing task disappear', () => {
  const { inspection, expected } = fixture()
  inspection.execution_plan.work_items.push(inspection.execution_plan.work_items[0]!)
  expect(() => hitchPreparedArtifacts(inspection, expected)).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
  inspection.execution_plan.work_items = [inspection.execution_plan.work_items[0]!]
  expect(() => hitchPreparedArtifacts(inspection, expected)).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
})
it('rejects different installed dependencies across repetitions of the same platform', () => {
  const { inspection, expected } = fixture(), first = hitchPreparedArtifacts(inspection, expected)
  const second = structuredClone(first)
  expect(() => assertStablePreparedArtifacts([...first, ...second])).not.toThrow()
  second[0]!.artifact.artifact_integrity = canonicalDigest('changed-closure')
  expect(() => assertStablePreparedArtifacts([...first, ...second])).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
})

it('pins exactly the requested task platforms and rejects missing or conflicting assignments', () => {
  const { inspection, expected } = fixture(), bindings = hitchPreparedArtifacts(inspection, expected)
  expect(artifactPins(bindings, ['a'])).toEqual([{ platform: 'linux-arm64',
    artifact_id: canonicalDigest('linux-arm64'), artifact_integrity: canonicalDigest(['tree', 'linux-arm64']),
    entrypoint_integrity: canonicalDigest(['entry', 'linux-arm64']) }])
  expect(artifactPins(bindings, ['b', 'a']).map(pin => pin.platform)).toEqual(['linux-arm64', 'linux-x64'])
  expect(() => artifactPins(bindings, ['missing'])).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
  const conflict = { ...bindings[0]!, artifact: { ...bindings[0]!.artifact, artifact_integrity: canonicalDigest('drift') } }
  expect(() => artifactPins([...bindings, conflict], ['a'])).toThrow(expect.objectContaining({ code: 'hitch-artifact-identity' }))
})
