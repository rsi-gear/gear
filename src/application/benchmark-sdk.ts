import type { ProjectConfig } from '../domain/project.js'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { resourceSdkEnvironment } from '../adapters/hitch/resource-sdk.js'
import { profile, profileName, profileRoot } from './profile-store.js'

/** Authoring can precede profile setup; configured Hitch projects use that SDK. */
export async function benchmarkSdkEnvironment(config: ProjectConfig): Promise<NodeJS.ProcessEnv> {
  const present = await lstat(join(profileRoot(), `${profileName(config.target.profile)}.json`)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (!present) return {}
  const selected = await profile(config.target.profile)
  return 'kind' in selected && selected.kind === 'hitch'
    ? resourceSdkEnvironment({ executable: selected.executable })
    : {}
}
