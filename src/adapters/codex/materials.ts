import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { materialReferences } from '../../domain/materials.js'
import { GearError } from '../../domain/errors.js'
import type { CodexJob } from './contracts.js'
export async function stageMaterials(job: CodexJob, root: string) {
  const entries: Array<[string, { operation_id: string; digest: string; file: string }]> = []
  const readPaths: string[] = []
  for (const [name, ref] of Object.entries(materialReferences(job.input.request.operation))) {
    const material = job.input.request.materials?.[name]
    if (
      !material ||
      material.operation_id !== ref.operation_id ||
      canonicalDigest(material.data) !== material.digest
    )
      throw new GearError(
        'material-identity-mismatch',
        'Role materials differ from the frozen operation result',
      )
    const path = join(root, 'materials', `${name}.json`)
    await mkdir(join(root, 'materials'), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(material.data, null, 2), { mode: 0o400, flag: 'wx' })
    readPaths.push(path)
    entries.push([
      name,
      { operation_id: ref.operation_id, digest: material.digest, file: `../materials/${name}.json` },
    ])
  }
  return { index: Object.fromEntries(entries), readPaths }
}
