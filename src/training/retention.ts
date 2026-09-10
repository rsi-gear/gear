import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { digestJson } from './digest.js'
import { parseContentRef, requireContract } from './schema.js'
import { atomicWrite, digestBytes, TrainingContentStore } from './store.js'
import { contentDependencies, ModelNodeTransport, snapshotFileEntries } from './transport.js'
import type { ContentRef, NodeIdentity } from './types.js'

const MAX_METADATA = 16 * 1024 * 1024
interface RetainedObject { ref: ContentRef; size: number; kind: 'metadata' | 'file' }
interface RetentionReceipt {
  schemaVersion: 1; kind: 'model-node-retention'; node: NodeIdentity; roots: ContentRef[]; objects: RetainedObject[]
  controllerObjects: Array<{ ref: ContentRef; size: number }>
}

/** Verify private controller dependencies without disclosing their bytes to the node. */
async function verifyControllerClosure(store: TrainingContentStore, root: ContentRef): Promise<{ size: number; nodeRoots: ContentRef[] }> {
  const queue = [{ ref: root, opaque: false, size: undefined as number | undefined }], seen = new Map<string, ContentRef>()
  const nodeRoots: ContentRef[] = []
  let total = 0, rootSize = 0
  for (let i = 0; i < queue.length; i++) {
    const { ref, opaque, size } = queue[i]!
    parseContentRef(ref)
    const prior = seen.get(ref.digest)
    requireContract(!prior || digestJson(prior) === digestJson(ref), 'content-media-type-drift', 'controller content has conflicting media types')
    let observedSize: number
    try { observedSize = (await stat(store.path(ref.digest))).size }
    catch (error) {
      if (i > 0 && !opaque && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A later rollout can reference an export whose descriptor has not yet
        // reached collect. Require a node receipt for it, without downloading
        // files or silently accepting a missing private controller anchor.
        if (!prior) { seen.set(ref.digest, ref); nodeRoots.push(ref) }
        requireContract(seen.size <= 4096 && queue.length <= 100_000, 'content-graph-limit', 'controller dependency graph exceeds its limit')
        continue
      }
      throw error
    }
    requireContract(size === undefined || size === observedSize, 'content-size-drift', 'controller snapshot size differs')
    if (prior) continue
    seen.set(ref.digest, ref)
    requireContract(seen.size <= 4096 && queue.length <= 100_000, 'content-graph-limit', 'controller dependency graph exceeds its limit')
    if (!i) rootSize = observedSize
    await store.verifyFile(ref)
    if (opaque || ref.mediaType !== 'application/json') continue
    total += observedSize
    requireContract(total <= MAX_METADATA, 'content-metadata-limit', 'controller metadata exceeds 16 MiB')
    const value = await store.readJson<Record<string, unknown>>(ref)
    if (snapshotFileEntries(value)) {
      // Canonical controller evidence can point back through a policy lease to
      // its remote HF snapshot. Verify that edge on the node, never by fetching
      // its weights or by treating the private evidence as an opaque dead end.
      requireContract(i !== 0, 'missing-node-content', 'a missing node snapshot cannot be replaced by controller metadata')
      nodeRoots.push(ref); continue
    }
    if (value?.format === 'harbor-dataset' && [1, 2].includes(Number(value.schemaVersion))) {
      requireContract(Array.isArray(value.files), 'invalid-file-manifest', 'controller dataset files are missing')
      for (const entry of value.files as Array<{ contentRef: ContentRef; size: number; sha256: string }>) {
        requireContract(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.sha256 === entry.contentRef?.digest,
          'invalid-file-manifest', 'controller dataset file size or digest differs')
        queue.push({ ref: parseContentRef(entry.contentRef), opaque: true, size: entry.size })
      }
    } else queue.push(...contentDependencies(value).map(ref => ({ ref, opaque: false, size: undefined })))
  }
  requireContract(rootSize <= MAX_METADATA, 'content-metadata-limit', 'controller anchor exceeds 16 MiB')
  return { size: rootSize, nodeRoots }
}

/** Node files stay durable on the pinned node; only bounded, verified metadata enters this store. */
export async function retainContentGraph(transport: ModelNodeTransport, store: TrainingContentStore, roots: ContentRef[]): Promise<void> {
  const controller = new Map<string, { ref: ContentRef; size: number }>()
  const retainedRoots = [...roots], remoteEdges = new Map(roots.map(ref => [ref.digest, ref]))
  let result = await transport.call('cas.retain', { roots, controllerObjects: [] }) as {
    receipt: RetentionReceipt; receiptDigest: string; metadata: Array<{ ref: ContentRef; data: string }>
    missingControllerRefs?: ContentRef[]
  }
  if (result?.missingControllerRefs) {
    requireContract(result.missingControllerRefs.length > 0 && result.missingControllerRefs.length <= 4096,
      'invalid-retention-receipt', 'node returned an invalid controller dependency list')
    for (const ref of result.missingControllerRefs) {
      parseContentRef(ref)
      requireContract(!controller.has(ref.digest), 'invalid-retention-receipt', 'duplicate controller dependency')
      let closure: Awaited<ReturnType<typeof verifyControllerClosure>>
      try { closure = await verifyControllerClosure(store, ref) }
      catch (error) {
        requireContract((error as NodeJS.ErrnoException).code !== 'ENOENT', 'missing-node-content', 'referenced content is missing from both model node and controller')
        throw error
      }
      controller.set(ref.digest, { ref, size: closure.size })
      for (const remote of closure.nodeRoots) {
        const prior = remoteEdges.get(remote.digest)
        requireContract(!prior || digestJson(prior) === digestJson(remote), 'content-media-type-drift', 'remote evidence edge has conflicting media types')
        if (!prior) { remoteEdges.set(remote.digest, remote); retainedRoots.push(remote) }
      }
    }
    result = await transport.call('cas.retain', { roots: retainedRoots, controllerObjects: [...controller.values()] }) as typeof result
    requireContract(!result?.missingControllerRefs, 'missing-node-content', 'private controller evidence references content absent from the model node')
  }
  const receipt = result?.receipt
  requireContract(receipt?.schemaVersion === 1 && receipt.kind === 'model-node-retention'
    && digestJson(receipt.node) === digestJson(transport.identity) && digestJson(receipt.roots) === digestJson(retainedRoots)
    && result.receiptDigest === digestJson(receipt) && Array.isArray(receipt.objects) && receipt.objects.length <= 4096
    && Array.isArray(result.metadata) && Array.isArray(receipt.controllerObjects) && receipt.controllerObjects.length === controller.size,
  'invalid-retention-receipt', 'node retention receipt differs from its requested roots or identity')
  requireContract(digestJson(receipt.controllerObjects) === digestJson([...controller.values()].sort((a, b) => a.ref.digest.localeCompare(b.ref.digest))),
    'invalid-retention-receipt', 'node changed the verified controller dependencies')
  const objects = new Map<string, RetainedObject>(), bytes = new Map<string, Buffer>()
  for (const item of receipt.objects) {
    parseContentRef(item.ref)
    requireContract(item.ref.uri === `cas:${item.ref.digest}` && !objects.has(item.ref.digest)
      && Number.isSafeInteger(item.size) && item.size >= 0 && ['metadata', 'file'].includes(item.kind),
      'invalid-retention-receipt', 'retention inventory contains an invalid or duplicate object')
    objects.set(item.ref.digest, item)
  }
  let total = 0
  for (const item of result.metadata) {
    const record = objects.get(item.ref?.digest)
    requireContract(record?.kind === 'metadata' && digestJson(record.ref) === digestJson(item.ref) && !bytes.has(item.ref.digest)
      && typeof item.data === 'string' && item.data.length <= Math.ceil(MAX_METADATA / 3) * 4,
      'invalid-retention-metadata', 'retention reply contains undeclared, opaque or duplicate metadata')
    const value = Buffer.from(item.data, 'base64'); total += value.length
    requireContract(total <= MAX_METADATA && value.length === record.size && digestBytes(value) === item.ref.digest,
      'invalid-retention-metadata', 'retention metadata exceeds its limit or failed its digest')
    bytes.set(item.ref.digest, value)
  }
  const queue: Array<{ ref: ContentRef; kind: 'metadata' | 'file'; size?: number }> = retainedRoots.map(ref => ({ ref, kind: 'metadata' }))
  const seen = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const { ref, kind, size } = queue[i]!, record = objects.get(ref.digest)
    if (controller.has(ref.digest)) {
      requireContract(kind === 'metadata' && !record && digestJson(controller.get(ref.digest)!.ref) === digestJson(ref),
        'invalid-retention-receipt', 'controller metadata cannot replace a model-node file')
      seen.add(ref.digest); continue
    }
    requireContract(record && digestJson(record.ref) === digestJson(ref) && record.kind === kind && (size === undefined || size === record.size),
      'incomplete-retention-graph', 'retention does not cover the exact referenced content and size')
    if (seen.has(ref.digest)) continue
    seen.add(ref.digest)
    if (kind === 'file') continue
    const data = bytes.get(ref.digest)
    requireContract(data, 'incomplete-retention-graph', 'controller metadata is missing from the retained graph')
    if (ref.mediaType !== 'application/json') continue
    const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    const files = snapshotFileEntries(value)
    if (files) queue.push(...files.map(file => ({ ref: file.contentRef, size: file.size, kind: 'file' as const })))
    else {
      queue.push(...contentDependencies(value).map(ref => ({ ref, kind: 'metadata' as const })))
      if (value && value.schemaVersion === 1 && 'checkpointRef' in value && 'consumedBatchDigest' in value) {
        const digest = String(value.consumedBatchDigest)
        queue.push({ ref: parseContentRef({ uri: `cas:${digest}`, digest, mediaType: 'application/json' }), kind: 'metadata' })
      }
    }
    requireContract(queue.length <= 100_000, 'content-graph-limit', 'retention graph has too many edges')
  }
  requireContract(seen.size === objects.size + controller.size && [...objects.values()].filter(item => item.kind === 'metadata').length === bytes.size,
    'unexpected-retention-content', 'retention reply includes content outside the requested closure')
  for (const [digest, data] of bytes) await store.putBytes(data, objects.get(digest)!.ref.mediaType)
  await atomicWrite(join(store.root, 'remote-retentions', result.receiptDigest.slice(7) + '.json'), receipt)
}
