import { join } from 'node:path'
import { requireContract } from './schema.js'

/** Hitch's local benchmark identity includes the dataset directory's name. */
export function datasetDestination(manifest: unknown, destination: string): string {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return destination
  const value = manifest as Record<string, unknown>
  if (value.schemaVersion !== 2 || value.format !== 'harbor-dataset') return destination
  const name = value.name
  requireContract(typeof name === 'string' && !['', '.', '..'].includes(name) && !/[\/\\\0]/.test(name),
    'invalid-dataset-name', 'dataset name must be one path component')
  return join(destination, name)
}
