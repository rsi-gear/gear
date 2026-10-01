/** Stage workspaces preserve modes/empty directories and transfer opaque files. */
import { stat } from 'node:fs/promises'
import { requireContract } from './schema.js'
import { ModelNodeTransport, snapshotFileEntries } from './transport.js'
import { TrainingContentStore } from './store.js'
import type { ContentRef } from './types.js'

export function datasetSnapshotFileEntries(value: unknown): Array<{ contentRef: ContentRef; size: number }> | null {
  const manifest = value as Record<string, unknown> | null
  if (!manifest || manifest.schemaVersion !== 2 || manifest.format !== 'harbor-dataset') return null
  requireContract(Number.isInteger(manifest.mode) && Number(manifest.mode) >= 0 && Number(manifest.mode) <= 0o7777
    && Array.isArray(manifest.directories) && manifest.directories.length <= 4096,
  'invalid-stage-manifest', 'stage snapshot modes and directories are missing')
  requireContract(typeof manifest.name === 'string' && !!manifest.name && !['.', '..'].includes(manifest.name)
    && !/[\\/\0]/.test(manifest.name), 'invalid-stage-manifest', 'dataset name is invalid')
  const files = snapshotFileEntries({ schemaVersion: 1, format: 'trainer-files', files: manifest.files })!
  requireContract(files.length + manifest.directories.length <= 4096 && files.reduce((sum, file) => sum + file.size, 0) <= 64 * 1024 * 1024,
    'agent-artifact-limit', 'stage output exceeds 4096 entries or 64 MiB')
  for (const file of manifest.files as Array<Record<string, unknown>>) requireContract(Number.isInteger(file.mode)
    && Number(file.mode) >= 0 && Number(file.mode) <= 0o7777, 'invalid-stage-manifest', 'stage file mode is invalid')
  const names = new Set((manifest.files as Array<Record<string, unknown>>).map(file => file.path))
  for (const raw of manifest.directories as unknown[]) {
    const directory = raw as Record<string, unknown> | null
    requireContract(directory && typeof directory.path === 'string' && !/[\\\0]/.test(directory.path)
      && !directory.path.startsWith('/') && directory.path.split('/').every(part => !!part && !['.', '..'].includes(part))
      && !names.has(directory.path) && Number.isInteger(directory.mode) && Number(directory.mode) >= 0 && Number(directory.mode) <= 0o7777,
    'invalid-stage-manifest', 'dataset directory is unsafe or duplicated')
    names.add(directory.path)
  }
  return files
}

export async function uploadStageSnapshot(transport: ModelNodeTransport, store: TrainingContentStore, ref: ContentRef): Promise<void> {
  requireContract((await stat(store.path(ref.digest))).size <= 4 * 1024 * 1024, 'agent-artifact-limit', 'stage snapshot manifest exceeds 4 MiB')
  const files = datasetSnapshotFileEntries(await store.readJson(ref))
  requireContract(files, 'invalid-stage-manifest', 'expected a sealed stage workspace')
  for (const file of files) await transport.upload(store, file.contentRef)
  await transport.upload(store, ref)
}
