import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { ExperienceStore } from '../storage/experience.js'
import { builtinPolicyImplementationDigest, builtinPolicySources } from '../python/builtin-policy.js'
import { resolvePythonExecutable } from '../python/interpreter.js'
import { inspectPython } from '../python/runtime.js'
import type { CodexJob } from './contracts.js'
import { trajectoryGateway } from './trajectory-gateway.js'

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
  if (
    canonicalDigest(body) !== digest ||
    snapshot.run_id !== request.runId ||
    snapshot.implementation_identity !== body.implementation_identity ||
    body.implementation_identity !== builtinPolicyImplementationDigest ||
    body.available_records !== snapshot.records.length ||
    Buffer.byteLength(JSON.stringify(body.cards)) > 12 * 1024 ||
    snapshot.records.some((record) => record.scope.task_ids.some((id) => !seed.has(id)))
  )
    throw new GearError(
      'experience-context-mismatch',
      'Meta experience does not match the frozen seed reservation',
    )
  if (!snapshot.records.length) return { ...empty, input: { ...request.experience, reader: null } }
  const directory = join(root, 'experience'),
    sources = join(directory, 'sources')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await store.copyClosure(snapshot, directory)
  await rename(join(directory, snapshot.digest.slice(7) + '.json'), join(directory, 'snapshot.json'))
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
          view: 'card|task-results|diff|trajectory|modification-use|verifier',
          limit: 20,
        },
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
