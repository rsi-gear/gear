import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { ExperienceStore } from '../storage/experience.js'
import { builtinPolicyImplementationDigest, builtinPolicySources } from '../python/builtin-policy.js'
import { resolvePythonExecutable } from '../python/interpreter.js'
import { inspectPython } from '../python/runtime.js'
import type { CodexJob } from './contracts.js'
import { trajectoryGateway } from './trajectory-gateway.js'
import { harnessAdapter } from '../../application/harness-adapters.js'
import { TargetStore } from '../storage/targets.js'

/** Copy only verified, sanitized bytes into the operation sandbox. No private directory mount. */
export async function stageExperience(
  job: CodexJob,
  root: string,
  registerDispose?: (dispose: () => Promise<void>) => void,
) {
  const { context, request } = job.input
  const empty = {
    readPaths: [] as string[],
    writePaths: [] as string[],
    protectedPaths: [] as string[],
    sockets: [] as string[],
    async dispose() {},
  }
  if (!request.experience) return { ...empty, input: null }
  const { digest, ...body } = request.experience
  const store = new ExperienceStore(join(dirname(context.targets), 'experience'))
  const snapshot = await store.read(body.snapshot_digest)
  const seed = new Set(context.tasks.map((task) => task.id))
  const baseline = request.experience.baseline
  const expectedBaselineEvidence = baseline
    ? request.evidence.filter((cell) => cell.candidate_id === baseline.candidate_id && seed.has(cell.task_id))
    : []
  const baselineEvidenceSlots = new Set(
    expectedBaselineEvidence.map((cell) => `${cell.task_id}\0${cell.repetition}`),
  )
  const baselineReferenceSlots = new Set<string>()
  if (
    canonicalDigest(body) !== digest ||
    snapshot.run_id !== request.runId ||
    snapshot.implementation_identity !== body.implementation_identity ||
    body.implementation_identity !== builtinPolicyImplementationDigest ||
    body.available_records !== snapshot.records.length ||
    Buffer.byteLength(JSON.stringify(body.cards)) > 12 * 1024 ||
    snapshot.records.some((record) => record.scope.task_ids.some((id) => !seed.has(id))) ||
    (baseline !== undefined &&
      (request.operation.kind !== 'diagnose_seed' ||
        request.operation.candidate_id !== baseline.candidate_id ||
        !expectedBaselineEvidence.length ||
        canonicalDigest(baseline.evidence) !== canonicalDigest(expectedBaselineEvidence) ||
        baseline.trajectory_refs.some((item) => {
          const slot = `${item.task_id}\0${item.repetition}`
          const valid =
            item.candidate_id === baseline.candidate_id &&
            Number.isSafeInteger(item.repetition) &&
            item.repetition >= 0 &&
            baselineEvidenceSlots.has(slot) &&
            !baselineReferenceSlots.has(slot) &&
            /^trajectory:[a-f0-9]{64}$/u.test(item.ref) &&
            (item.status === 'available' || item.status === 'unavailable') &&
            (item.status === 'available'
              ? typeof item.content_digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item.content_digest)
              : item.content_digest === null) &&
            (item.reason === null || typeof item.reason === 'string')
          baselineReferenceSlots.add(slot)
          return !valid
        }) ||
        !/^sha256:[a-f0-9]{64}$/u.test(baseline.candidate_digest)))
  )
    throw new GearError(
      'experience-context-mismatch',
      'Meta experience does not match the frozen seed reservation',
    )
  if (!snapshot.records.length && !request.experience.baseline)
    return { ...empty, input: { ...request.experience, reader: null } }
  const directory = join(root, 'experience'),
    sources = join(directory, 'sources')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await store.copyClosure(snapshot, directory)
  await rename(join(directory, snapshot.digest.slice(7) + '.json'), join(directory, 'snapshot.json'))
  if (baseline) {
    const runRoot = dirname(context.targets)
    const manifestPath = join(runRoot, 'target-manifests', `${baseline.candidate_id}.json`)
    const sourceManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { runtimeIdentity: string }
    const targetStore = new TargetStore(
      runRoot,
      harnessAdapter(context.targetAdapter),
      sourceManifest.runtimeIdentity,
    )
    const manifest = await targetStore.verify(baseline.candidate_id)
    if (manifest.digest !== baseline.candidate_digest)
      throw new GearError('experience-context-mismatch', 'Baseline target differs from its reservation')
    const baselineDirectory = join(directory, 'baseline')
    const sourceRoot = join(baselineDirectory, 'source')
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
    for (const resource of await targetStore.readResources(baseline.candidate_id)) {
      const destination = join(sourceRoot, resource.path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, resource.bytes, { mode: resource.executable ? 0o500 : 0o400 })
    }
    await writeFile(
      join(baselineDirectory, 'evidence.json'),
      JSON.stringify({ candidate_id: baseline.candidate_id, evidence: baseline.evidence }),
      { mode: 0o400 },
    )
  }
  for (const [name, source] of Object.entries(builtinPolicySources)) {
    const path = join(sources, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, source, { mode: 0o400 })
  }
  const python = await inspectPython(context.experiencePython ?? resolvePythonExecutable())
  const bootstrap = `import sys;sys.path.insert(0,${JSON.stringify(sources)});from gear.experience import main;raise SystemExit(main())`
  const gateway = context.artifactReader
    ? await trajectoryGateway(
        root,
        dirname(context.targets),
        snapshot,
        context.artifactReader,
        python.executable,
        registerDispose,
        request.experience.baseline?.trajectory_refs,
      )
    : undefined
  return {
    readPaths: [...python.readPaths, directory, ...(gateway?.readPaths ?? [])],
    writePaths: gateway?.writePaths ?? [],
    protectedPaths: context.artifactReader
      ? [(context.artifactReader.configuration as { root: string }).root]
      : [],
    sockets: gateway?.sockets ?? [],
    dispose: () => gateway?.dispose() ?? Promise.resolve(),
    input: {
      ...request.experience,
      reader: {
        argv: [
          await realpath(python.executable),
          '-I',
          '-B',
          '-c',
          bootstrap,
          join(directory, 'snapshot.json'),
          ...(gateway ? [gateway.path] : []),
        ],
        transport: 'one JSON request on stdin; bounded JSON reply on stdout',
        query: {
          action: 'query',
          query: { query: '', task_ids: [], paths: [], semantic_targets: [], effects: [] },
          limit: 10,
        },
        read: {
          action: 'read',
          ref: 'experience:<digest from a card>',
          view: 'card|task-results|diff|source|trajectory|modification-use|verifier',
          limit: 20,
        },
        ...(request.experience.baseline
          ? {
              baseline: {
                candidate_id: request.experience.baseline.candidate_id,
                candidate_digest: request.experience.baseline.candidate_digest,
                source_root: join(directory, 'baseline', 'source'),
                evidence_path: join(directory, 'baseline', 'evidence.json'),
                trajectory_refs: request.experience.baseline.trajectory_refs,
                trajectory: {
                  action: 'trajectory',
                  ref: 'baseline',
                  source_ref: 'trajectory:<ref from baseline trajectory_refs>',
                  query: { limit: 20 },
                },
              },
            }
          : {}),
        ...(gateway
          ? {
              trajectory: {
                action: 'trajectory',
                ref: 'experience:<record digest>',
                source_ref: 'trajectory:<ref from trajectory view>',
                query: { limit: 20 },
                scope: 'Canonical session only; child-session coverage is reported separately.',
              },
            }
          : {}),
        pagination:
          'Pass next_cursor as cursor with the same query or read view. Historical seed observations are descriptive.',
      },
    },
  }
}
