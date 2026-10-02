import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContentRef, requireContract } from './schema.js'
import { TrainingContentStore } from './store.js'
import type { ContentRef } from './types.js'

export interface TrainingScript { entrypoint: string; sourceRef: ContentRef }
export interface ScriptSource { schemaVersion: 1; kind: 'training-script-source'; files: { path: string; contentRef: ContentRef }[] }

export function parseTrainingScript(value: unknown): TrainingScript {
  const input = value as TrainingScript | null
  requireContract(input && Object.keys(input).sort().join(',') === 'entrypoint,sourceRef'
    && typeof input.entrypoint === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/.test(input.entrypoint),
  'invalid-script-entrypoint', 'script requires sourceRef and module:factory entrypoint')
  parseContentRef(input.sourceRef)
  requireContract(input.sourceRef.mediaType === 'application/json', 'invalid-script-source', 'sourceRef must identify a JSON source manifest')
  return structuredClone(input)
}

/** Only an explicitly selected source directory is published. Third-party dependencies stay installed on the worker. */
export async function sealScriptSource(store: TrainingContentStore, directory: string, entrypoint: string): Promise<TrainingScript> {
  requireContract(typeof entrypoint === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/.test(entrypoint), 'invalid-script-entrypoint', 'entrypoint must be module:factory')
  const files: ScriptSource['files'] = []
  let size = 0
  async function visit(relative: string): Promise<void> {
    const path = join(directory, relative), stat = await lstat(path)
    requireContract(!stat.isSymbolicLink(), 'unsafe-script-source', `source must not contain symlinks: ${relative}`)
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (['__pycache__', '.git', '.venv', 'node_modules'].includes(name)) continue
        await visit(relative ? `${relative}/${name}` : name)
      }
    } else {
      requireContract(stat.isFile() && files.length < 1024 && !relative.startsWith('.') && !relative.split('/').some(part => part.startsWith('.')),
        'unsafe-script-source', 'use a dedicated recipe directory, without hidden files, special files or more than 1024 files')
      const bytes = await readFile(path); size += bytes.length
      requireContract(size <= 16 * 1024 * 1024, 'script-source-too-large', 'recipe source is limited to 16 MiB; use runtime dependencies for models and data')
      files.push({ path: relative, contentRef: await store.putBytes(bytes, 'application/octet-stream') })
    }
  }
  requireContract((await lstat(directory)).isDirectory(), 'invalid-script-source', 'source must be a dedicated directory')
  await visit('')
  const modulePath = entrypoint.split(':')[0]!.replaceAll('.', '/')
  requireContract(files.some(file => file.path === `${modulePath}.py` || file.path === `${modulePath}/__init__.py`), 'missing-script-entrypoint', 'entrypoint module must be present in the source directory')
  return parseTrainingScript({ entrypoint, sourceRef: await store.putJson({ schemaVersion: 1, kind: 'training-script-source', files } satisfies ScriptSource) })
}
