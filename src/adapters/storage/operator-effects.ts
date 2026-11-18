import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import type { ArtifactRef, Call, CandidateRef, SourceRef } from '../../domain/algorithm-wire-v2.js'
import type {
  ExecutionTarget,
  LocalEffectReceipt,
  OperatorCallEntry,
  OperatorMaterial,
} from '../../domain/operator-run.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { materialPath as relativePath } from '../../domain/material-path.js'
import type { RunJournal } from '../../domain/run.js'
import type { OperatorEffects } from '../../ports/operator-effects.js'
import { builtinPolicy } from '../python/builtin-policy.js'
import type { TargetStore } from './targets.js'
import { targetManifest } from './targets.js'
import { assertMutationPath } from '../../domain/mutation-policy.js'
import { operatorObjective } from '../../domain/operator-objective.js'
import { targetDiff } from './target-diff.js'
import type { LibraryStore } from './libraries.js'
import type { OperationProvider } from '../../ports/operations.js'

const rawDigest = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`

export class StoredOperatorEffects implements OperatorEffects {
  get capabilities() {
    return [
      'artifact_read',
      'exact_edits',
      'history_read',
      'evidence_read',
      'target_files',
      ...(this.libraries ? ['library_commit', 'library_publish'] : []),
    ]
  }
  constructor(
    readonly targets: TargetStore,
    readonly libraries?: LibraryStore,
    readonly provider?: OperationProvider,
  ) {}

  validateSchema(schema: Record<string, Json>, value?: Json): void {
    builtinPolicy('operator_schema', { schema, ...(value !== undefined ? { value } : {}) })
  }
  private candidate(journal: RunJournal, ref: CandidateRef): { id: string; digest: string } {
    if (ref.run_id === journal.id) return { id: ref.candidate_id, digest: ref.digest }
    const imported = journal.spec.operatorPolicy?.imports?.find(
      (item) => canonicalDigest(item.ref) === canonicalDigest(ref),
    )?.candidate
    if (!imported) throw new GearError('source-not-admitted', 'Candidate has no frozen import copy')
    return imported
  }

  async prepareTarget(
    journal: RunJournal,
    candidate: CandidateRef,
    assets: ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<ExecutionTarget> {
    const materials = await this.materials(journal, [candidate, ...assets], signal)
    const files = structuredClone(materials[0]!.files!),
      touched = new Set<string>()
    let total = Object.values(files).reduce(
      (sum, file) => sum + Buffer.from(file.content, 'base64').length,
      0,
    )
    for (const material of materials.slice(1)) {
      const snapshot = material.value as {
        data?: {
          kind?: string
          files?: Record<string, { content: string; encoding: string; executable: boolean }>
        }
      }
      const data = snapshot?.data
      if (
        'candidate_id' in material.ref ||
        material.ref.kind !== 'library' ||
        data?.kind !== 'target-files-v1' ||
        !data.files ||
        typeof data.files !== 'object' ||
        Array.isArray(data.files)
      )
        throw new GearError(
          'target-asset-unsupported',
          'Executable assets require library snapshots containing TargetFiles',
        )
      for (const [path, file] of Object.entries(data.files)) {
        relativePath(path)
        assertMutationPath(path, this.targets.adapter.mutationPolicy)
        if (touched.has(path))
          throw new GearError('target-asset-conflict', 'Two library assets define the same target path')
        touched.add(path)
        if (
          !file ||
          typeof file.content !== 'string' ||
          typeof file.executable !== 'boolean' ||
          !['utf-8', 'base64'].includes(file.encoding)
        )
          throw new GearError('invalid-target-asset', 'TargetFiles requires explicit regular file content')
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
        if (file.encoding === 'base64' && bytes.toString('base64') !== file.content)
          throw new GearError('invalid-target-asset', 'Invalid base64 asset content')
        total += bytes.length
        if (bytes.length > 1024 * 1024 || total > 16 * 1024 * 1024 || Object.keys(files).length > 4096)
          throw new GearError('material-too-large', 'Effective target exceeds its file budget')
        Object.defineProperty(files, path, {
          value: { content: bytes.toString('base64'), encoding: 'base64', executable: file.executable },
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
    }
    const parent = await this.targets.verify(candidate.candidate_id)
    const resources = Object.entries(files)
      .map(([path, file]) => ({ path, digest: canonicalDigest(file.content), executable: file.executable }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const manifest = targetManifest(
      this.targets.adapter,
      this.targets.runtimeIdentity,
      parent.baseRef,
      resources,
    )
    return {
      id: 'effective_' + canonicalDigest([candidate, assets, manifest.digest]).slice(7, 39),
      digest: manifest.digest,
      base: candidate,
      assets,
      files,
    }
  }

  async materials(
    journal: RunJournal,
    refs: SourceRef[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<OperatorMaterial[]> {
    const result: OperatorMaterial[] = [],
      seen = new Set<string>()
    let total = 0
    for (const ref of refs) {
      signal.throwIfAborted()
      const key = canonicalDigest(ref)
      if (seen.has(key)) continue
      seen.add(key)
      if ('candidate_id' in ref) {
        const candidate = this.candidate(journal, ref)
        const manifest = await this.targets.verify(candidate.id)
        if (manifest.digest !== candidate.digest)
          throw new GearError('material-identity-mismatch', 'Source candidate changed')
        const files: NonNullable<OperatorMaterial['files']> = {}
        for (const file of manifest.resources) {
          const content = await readFile(join(this.targets.path(candidate.id), file.path))
          total += content.length
          if (content.length > 1024 * 1024 || total > 8 * 1024 * 1024)
            throw new GearError('material-too-large', 'Authorized materials exceed the frozen file budget')
          if (canonicalDigest(content.toString('base64')) !== file.digest)
            throw new GearError('material-identity-mismatch', 'Source file changed during capture')
          Object.defineProperty(files, file.path, {
            value: { content: content.toString('base64'), encoding: 'base64', executable: file.executable },
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
        result.push({ ref, files })
      } else {
        const artifact = journal.operators!.artifacts.find((item) => canonicalDigest(item.ref) === key)
        if (!artifact) throw new GearError('artifact-not-authorized', 'Material has no admitted artifact')
        if (artifact.external) {
          if (!this.provider?.readExecutionArtifact)
            throw new GearError(
              'operator-capability-unsupported',
              'Provider cannot read the frozen execution artifact',
            )
          const data = (artifact.value as { data?: { entries?: Array<{ path: string; bytes: number }> } })
            .data
          const files: NonNullable<OperatorMaterial['files']> = {}
          for (const item of data?.entries ?? [{ path: 'artifact.json', bytes: 0 }]) {
            relativePath(item.path)
            if (item.bytes > 1024 * 1024 || total + item.bytes > 8 * 1024 * 1024)
              throw new GearError('material-too-large', 'Use paged reads for large execution artifacts')
            const bytes = await this.provider.readExecutionArtifact(
              artifact,
              data?.entries ? item.path : null,
              signal,
            )
            total += bytes.length
            if (bytes.length > 1024 * 1024 || total > 8 * 1024 * 1024)
              throw new GearError('material-too-large', 'Use paged reads for large execution artifacts')
            Object.defineProperty(files, item.path, {
              value: { content: bytes.toString('base64'), encoding: 'base64', executable: false },
              enumerable: true,
            })
          }
          result.push({ ref, files })
          continue
        }
        total += Buffer.byteLength(JSON.stringify(artifact.value))
        if (total > 8 * 1024 * 1024)
          throw new GearError('material-too-large', 'Authorized materials exceed the frozen byte budget')
        result.push({ ref, value: artifact.value })
      }
    }
    return result
  }

  validateLocal(call: Call): void {
    const effect = call.effect
    if (effect.kind === 'library' && this.libraries) return
    if (effect.kind === 'candidate' && effect.input.mode === 'edits') {
      effect.input.plan.edits.forEach((edit) => relativePath(edit.path))
      return
    }
    if (effect.kind === 'read') {
      if (effect.input.view === 'artifact' && effect.input.path !== null) relativePath(effect.input.path)
      return
    }
    throw new GearError('operator-capability-unsupported', `Unsupported local effect: ${effect.kind}`)
  }

  async execute(
    journal: RunJournal,
    entry: OperatorCallEntry,
    signal: AbortSignal,
  ): Promise<LocalEffectReceipt> {
    signal.throwIfAborted()
    const effect = entry.call.effect
    if (effect.kind === 'library' && this.libraries) {
      const input = effect.input
      if (input.mode === 'publish')
        return {
          artifacts: [],
          value: (await this.libraries.publish({
            name: input.name,
            snapshot: input.snapshot,
            expected_revision: input.expected_revision,
            commit_id: entry.id,
          })) as unknown as Json,
        }
      const sources = [...(input.base ? [input.base] : []), ...Object.values(input.assets)]
      const value = { base: input.base, assets: input.assets, data: input.data }
      const ref = {
        run_id: journal.id,
        kind: 'library',
        digest: canonicalDigest({ kind: 'library', value, sources }),
        visibility: 'optimization' as const,
      }
      const artifact = { ref, value, sources }
      await this.libraries.save(artifact)
      return { artifacts: [artifact], value: { snapshot: ref } }
    }
    if (effect.kind === 'candidate' && effect.input.mode === 'edits') {
      const input = effect.input,
        base = entry.materials.find(
          (material) => canonicalDigest(material.ref) === canonicalDigest(input.base),
        )!
      const blobs = Object.fromEntries(
        entry.materials.flatMap((material) =>
          !('candidate_id' in material.ref) && material.ref.kind === 'blob'
            ? [[material.ref.digest, material.value]]
            : [],
        ),
      )
      let files: NonNullable<OperatorMaterial['files']>
      try {
        files = builtinPolicy<NonNullable<OperatorMaterial['files']>>('operator_edits', {
          files: base.files,
          plan: input.plan,
          blobs,
        })
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return {
          value: null,
          artifacts: [],
          error: {
            code: 'edit-plan-conflict',
            message: 'Exact edit preconditions or file bounds were not satisfied',
          },
        }
      }
      let manifest
      try {
        manifest = await this.targets.materialize(entry.candidateId!, input.base.candidate_id, files)
      } catch (error) {
        if (
          !(error instanceof GearError) ||
          !['candidate-mutation-rejected', 'candidate-harness-rejected'].includes(error.code)
        )
          throw error
        return { value: null, artifacts: [], error: { code: error.code, message: error.message } }
      }
      const candidate = {
        id: entry.candidateId!,
        parent_id: input.base.candidate_id,
        digest: manifest.digest,
      }
      const parent = journal.candidates.find((item) => item.id === input.base.candidate_id)!
      return {
        candidate,
        artifacts: [],
        value: {
          candidate: { run_id: journal.id, candidate_id: candidate.id, digest: candidate.digest },
          change: (await targetDiff(this.targets, parent, candidate)) as unknown as Json,
          sources: input.sources,
        },
      }
    }
    if (effect.kind === 'read' && effect.input.view !== 'artifact') {
      const input = effect.input
      let records: Json[],
        value: Json,
        artifacts: LocalEffectReceipt['artifacts'] = []
      if (input.view === 'history') {
        const snapshot = journal.operators!.artifacts.find(
          (item) => canonicalDigest(item.ref) === canonicalDigest(input.snapshot),
        )!
        if (snapshot.ref.kind !== 'history')
          throw new GearError('invalid-history-ref', 'History query requires a frozen history snapshot')
        try {
          records = builtinPolicy<Json[]>('operator_history', {
            events: (snapshot.value as { events: Json[] }).events,
            query: input.query,
          })
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          return {
            value: null,
            artifacts: [],
            error: {
              code: 'invalid-history-query',
              message: 'History query does not satisfy the supported filter contract',
            },
          }
        }
        value = { snapshot: snapshot.ref }
      } else {
        const spec = input.spec
        if (spec.objective_ref !== canonicalDigest(operatorObjective(journal.spec.objective)))
          throw new GearError(
            'evidence-objective-mismatch',
            'Evidence selection changed the frozen objective',
          )
        const assessments = spec.assessments.map((ref) =>
          journal.operators!.artifacts.find((item) => canonicalDigest(item.ref) === canonicalDigest(ref))!,
        )
        let selected: { spec: Json; records: Json[] }
        try {
          selected = builtinPolicy('operator_evidence', { spec, assessments })
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          return {
            value: null,
            artifacts: [],
            error: {
              code: 'invalid-evidence-selection',
              message: 'Evidence selection has mismatched, unplanned or duplicate samples',
            },
          }
        }
        const sources = [spec.candidate]
        const ref = {
          run_id: journal.id,
          kind: 'evidence_set',
          digest: canonicalDigest({ kind: 'evidence_set', value: selected, sources }),
          visibility: 'optimization' as const,
        }
        artifacts = [{ ref, value: selected, sources }]
        records = selected.records
        value = { ref, spec }
      }
      const binding = canonicalDigest(
        input.view === 'history' ? [input.snapshot, input.query, input.limit] : [input.spec, input.limit],
      )
      let offset = 0
      if (input.cursor !== null) {
        let cursor: { binding?: string; offset?: number }
        try {
          cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        } catch {
          throw new GearError('invalid-material-cursor', 'Invalid page cursor')
        }
        if (
          cursor.binding !== binding ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset! < 0 ||
          cursor.offset! > records.length
        )
          throw new GearError('invalid-material-cursor', 'Cursor does not match the frozen query')
        offset = cursor.offset!
      }
      const page: Json[] = []
      let bytes = Buffer.byteLength(JSON.stringify(value))
      for (const record of records.slice(offset, offset + input.limit)) {
        const size = Buffer.byteLength(JSON.stringify(record))
        if (bytes + size > 900 * 1024) break
        bytes += size
        page.push(record)
      }
      if (!page.length && offset < records.length)
        throw new GearError(
          'material-page-too-large',
          'One history or evidence record exceeds the page budget',
        )
      const next = offset + page.length,
        complete = next === records.length
      return {
        artifacts,
        value: {
          ...(value as Record<string, Json>),
          records: page,
          offset,
          total_records: records.length,
          loaded: complete && offset === 0,
          complete,
          cursor: complete
            ? null
            : Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url'),
        },
      }
    }
    if (effect.kind === 'read' && effect.input.view === 'artifact') {
      const input = effect.input,
        binding = canonicalDigest([input.ref, input.path, input.max_bytes])
      let offset = 0
      if (input.cursor !== null) {
        let cursor: { binding?: string; offset?: number }
        try {
          cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        } catch {
          throw new GearError('invalid-material-cursor', 'Invalid material cursor')
        }
        if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0)
          throw new GearError('invalid-material-cursor', 'Cursor belongs to another material request')
        offset = cursor.offset!
      }
      let content: Buffer
      if ('candidate_id' in input.ref) {
        const candidate = this.candidate(journal, input.ref)
        const manifest = await this.targets.verify(candidate.id)
        if (manifest.digest !== candidate.digest)
          throw new GearError('material-identity-mismatch', 'Candidate manifest changed')
        if (input.path !== null) {
          const file = manifest.resources.find((item) => item.path === input.path)
          if (!file) throw new GearError('material-path-missing', 'Path is absent from the sealed candidate')
          content = await readFile(join(this.targets.path(candidate.id), input.path))
          if (canonicalDigest(content.toString('base64')) !== file.digest)
            throw new GearError('material-identity-mismatch', 'Candidate file changed')
        } else content = Buffer.from(JSON.stringify(manifest.resources))
      } else {
        const artifact = journal.operators!.artifacts.find(
          (item) => canonicalDigest(item.ref) === canonicalDigest(input.ref),
        )!
        if (artifact.external) {
          if (!this.provider?.readExecutionArtifact)
            throw new GearError('operator-capability-unsupported', 'Execution artifact reader is unavailable')
          content = await this.provider.readExecutionArtifact(artifact, input.path, signal)
        } else {
          if (input.path !== null)
            throw new GearError('material-path-invalid', 'JSON artifacts do not accept file paths')
          content = Buffer.from(JSON.stringify(artifact.value))
        }
      }
      if (offset > content.length)
        throw new GearError('invalid-material-cursor', 'Cursor exceeds the material length')
      const page = content.subarray(offset, offset + input.max_bytes),
        next = offset + page.length
      return {
        artifacts: [],
        value: {
          ref: input.ref,
          path: input.path,
          encoding: 'base64',
          content: page.toString('base64'),
          content_digest: rawDigest(content),
          offset,
          total_bytes: content.length,
          complete: next === content.length,
          cursor:
            next === content.length
              ? null
              : Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url'),
        },
      }
    }
    throw new GearError('operator-capability-unsupported', 'Local effect is unavailable')
  }
}
