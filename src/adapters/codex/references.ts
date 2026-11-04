import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { candidateReferences } from '../../domain/candidate-references.js'
import { GearError } from '../../domain/errors.js'
import type { TargetManifest, TargetResource } from '../../domain/target.js'
import { snapshotTarget, targetResources } from '../storage/targets.js'
import type { CodexJob } from './contracts.js'

export async function stageCandidateReferences(job: CodexJob, root: string) {
  const { context, request } = job.input
  let totalBytes = 0
  const staged: Array<{ directory: string; resources: TargetResource[] }> = []
  const entries: Array<[string, { candidate_id: string; digest: string; directory: string }]> = []
  for (const [name, reference] of Object.entries(candidateReferences(request.operation))) {
    const manifest = JSON.parse(
      await readFile(
        join(dirname(context.targets), 'target-manifests', `${reference.candidate_id}.json`),
        'utf8',
      ),
    ) as TargetManifest
    const { digest, ...body } = manifest
    if (digest !== reference.digest || canonicalDigest(body) !== digest)
      throw new GearError('candidate-reference-mismatch', 'Reference candidate identity changed')
    const directory = join(root, 'references', name)
    const resources = await snapshotTarget(join(context.targets, reference.candidate_id), directory)
    if (canonicalDigest(resources) !== canonicalDigest(manifest.resources))
      throw new GearError('candidate-reference-mismatch', 'Reference candidate resources changed')
    for (const resource of resources) totalBytes += (await lstat(join(directory, resource.path))).size
    if (totalBytes > 64 * 1024 * 1024)
      throw new GearError('candidate-references-too-large', 'Reference directories exceed 64 MiB in total')
    staged.push({ directory, resources })
    entries.push([name, { ...reference, directory: `../references/${name}` }])
  }
  return {
    index: Object.fromEntries(entries),
    readPaths: staged.map((item) => item.directory),
    async verify(): Promise<void> {
      for (const item of staged)
        if (canonicalDigest(await targetResources(item.directory)) !== canonicalDigest(item.resources))
          throw new GearError('candidate-reference-changed', 'Read-only candidate reference was modified')
    },
  }
}
