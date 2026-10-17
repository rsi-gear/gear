import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RunJournal } from '../domain/run.js'
import type { ProjectConfig } from '../domain/project.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import { TargetStore, snapshotTarget, targetResources } from '../adapters/storage/targets.js'
import { publishFile, syncDirectory } from '../adapters/storage/atomic.js'
import { harnessAdapter } from './harness-adapters.js'
import { projectReport } from './project-report.js'
import { verifyBaseline } from './baseline.js'
import { projectResearch } from './research.js'
import { ProjectExperience } from './experience.js'
import { TrajectoryStore } from '../adapters/storage/trajectory.js'
import { ExperienceStore } from '../adapters/storage/experience.js'

export async function exportRun(root: string, journal: RunJournal) {
  if (journal.status !== 'completed') throw new GearError('run-incomplete', 'Export requires a completed run')
  const runRoot = join(root, '.gear/runs', journal.id)
  const baseline = await verifyBaseline(root, journal.id, journal.spec)
  const research = await projectResearch(root, journal)
  const config = JSON.parse(await readFile(join(runRoot, 'project.json'), 'utf8')) as ProjectConfig
  if (canonicalDigest(config) !== journal.spec.configDigest)
    throw new GearError('project-identity-mismatch', 'Frozen project configuration changed')
  const targets = new TargetStore(
    runRoot,
    harnessAdapter(config.target.adapter),
    journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
  )
  const experience = new ProjectExperience(runRoot, targets)
  const latestExperience = await experience.capture(journal)
  const experienceDigests = [
    ...new Set([
      latestExperience.digest,
      ...journal.operations.flatMap((entry) =>
        entry.request.experience ? [entry.request.experience.snapshot_digest] : [],
      ),
    ]),
  ].sort()
  // The export manifest contains only snapshot identities, never reconstructed detail records.
  const experienceBundle = {
    version: 3,
    latest_snapshot_digest: latestExperience.digest,
    snapshot_digests: experienceDigests,
  }
  if (Buffer.byteLength(JSON.stringify(experienceBundle)) > 4 * 1024 * 1024)
    throw new GearError('experience-size-limit', 'Experience export manifest exceeds 4 MiB')
  const trajectoryRefSet = new Set<string>()
  for (const digest of experienceDigests) {
    const snapshot = await experience.store.read(digest)
    for (const record of snapshot.records)
      for await (const reference of experience.store.trajectoryReferences(snapshot, record))
        trajectoryRefSet.add(reference.ref)
  }
  const trajectoryRefs = [...trajectoryRefSet].sort()
  const sources = []
  const trajectoryStore = new TrajectoryStore(join(runRoot, 'trajectory-sources'))
  for (const ref of trajectoryRefs) sources.push(await trajectoryStore.read('sha256:' + ref.slice(11)))
  const trajectoryBundle = { version: 1, reader: journal.spec.artifactReader ?? null, sources }
  const manifest = await targets.verify(journal.championId)
  if (manifest.digest !== journal.candidates.find((candidate) => candidate.id === journal.championId)?.digest)
    throw new GearError('target-identity-mismatch', 'Export target differs from the retained candidate')
  const parent = join(root, '.gear/exports'),
    destination = join(parent, journal.id)
  const report = await projectReport(root, journal)
  if (report.changes.status !== 'available')
    throw new GearError(report.changes.error.code, report.changes.error.message)
  const verifyExport = async () => {
    const exportedExperience = new ExperienceStore(join(destination, 'experience'))
    for (const digest of experienceDigests)
      await exportedExperience.verifyClosure(await exportedExperience.read(digest))
    if (
      canonicalDigest(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'))) !==
        canonicalDigest(manifest) ||
      canonicalDigest(JSON.parse(await readFile(join(destination, 'report.json'), 'utf8'))) !==
        canonicalDigest(report) ||
      canonicalDigest(await targetResources(join(destination, 'target'))) !==
        canonicalDigest(manifest.resources) ||
      canonicalDigest(JSON.parse(await readFile(join(destination, 'research-archive.json'), 'utf8'))) !==
        canonicalDigest(research) ||
      canonicalDigest(JSON.parse(await readFile(join(destination, 'experience-snapshots.json'), 'utf8'))) !==
        canonicalDigest(experienceBundle) ||
      canonicalDigest(JSON.parse(await readFile(join(destination, 'trajectory-sources.json'), 'utf8'))) !==
        canonicalDigest(trajectoryBundle) ||
      (baseline !== null &&
        canonicalDigest(JSON.parse(await readFile(join(destination, 'baseline-source.json'), 'utf8'))) !==
          canonicalDigest(baseline))
    )
      throw new GearError(
        'export-identity-mismatch',
        'Existing export contents differ from the retained snapshot',
      )
  }
  try {
    await verifyExport()
    return { run_id: journal.id, destination, retained: journal.championId }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = join(parent, `.${journal.id}-${randomUUID()}`)
  try {
    await snapshotTarget(targets.path(journal.championId), join(staging, 'target'))
    await publishFile(join(staging, 'manifest.json'), JSON.stringify(manifest), { immutable: true })
    await publishFile(join(staging, 'report.json'), JSON.stringify(report), { immutable: true })
    await publishFile(join(staging, 'research-archive.json'), JSON.stringify(research), { immutable: true })
    for (const digest of experienceDigests)
      await experience.store.copyClosure(await experience.store.read(digest), join(staging, 'experience'))
    await publishFile(join(staging, 'experience-snapshots.json'), JSON.stringify(experienceBundle), {
      immutable: true,
    })
    await publishFile(join(staging, 'trajectory-sources.json'), JSON.stringify(trajectoryBundle), {
      immutable: true,
    })
    if (baseline)
      await publishFile(join(staging, 'baseline-source.json'), JSON.stringify(baseline), { immutable: true })
    try {
      await rename(staging, destination)
      await syncDirectory(parent)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    await verifyExport()
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { run_id: journal.id, destination, retained: journal.championId }
}
