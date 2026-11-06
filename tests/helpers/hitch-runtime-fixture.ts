import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digestJson } from '../../src/adapters/hitch/json.js'
import { assertPreparedArtifactsMatch, type TaskArtifact } from '../../src/adapters/hitch/artifacts.js'
import type { HitchRuntimeAccess } from '../../src/adapters/hitch/preparation.js'
import type { HitchProfile } from '../../src/adapters/hitch/provider.js'

async function artifactId(profile: HitchProfile) {
  const state = await readFile(join(profile.root, 'remote.json'), 'utf8').then(JSON.parse, () => ({}))
  return state.preparedArtifactId ?? state.artifactIds?.[0] ?? digestJson('prepared-target')
}
/** Isolated test port; production profiles always use the public Hitch preparation SDK. */
export const fixtureRuntime: HitchRuntimeAccess = {
  async prepare(profile, context, connection) {
    const id = await artifactId(profile)
    return context.taskIds.map((task_id): TaskArtifact => ({
      task_id,
      artifact: {
        artifact_id: id,
        artifact_integrity: digestJson('dependencies-and-files'),
        entrypoint_integrity: digestJson('launcher'),
        harness_id: profile.harnessRef.split('@')[0]!,
        revision_identity: connection.revisionIdentity,
        platform: 'linux-arm64', node_version: 'v22.23.0', source_type: 'npm', storage: 'harbor-artifact-cache-v2',
      },
      runtime_contract: { docker_platform: 'linux/arm64', artifact_platform: 'linux-arm64', node_version: 'v22.23.0' },
    }))
  },
  async verify(profile, bindings) {
    const id = await artifactId(profile)
    assertPreparedArtifactsMatch(bindings.map(binding => ({ ...binding, artifact: { ...binding.artifact, artifact_id: id } })), bindings)
  },
}
