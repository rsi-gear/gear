import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { ArtifactRef, BindingSetRef } from '../contracts.js'
import { FileArtifactStore, assertDigest } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { CampaignStore } from '../runtime/store.js'
import { implementationClosureDigest } from '../data/identity.js'
import type { CandidateWorkspaceManager, CandidateWorkspaceHandle } from '../../candidate/workspace.js'
import type { CandidateCheckReport } from '../../harness/check-report.js'
import { HarnessBuilder } from '../../harness/builder.js'

export type SkillBody = { schemaVersion: 1; markdown: string }
export type SkillsLibrary = { schemaVersion: 1; skills: Array<{ name: string; contentRef: ArtifactRef }> }
export type SkillOverlayResult = { commitOid: string; manifestDigest: string;
  injectedSkillDigests: string[]; receiptRef: ArtifactRef }
export type SkillOverlayInput = { operationId: string; baseHarness: { commitOid: string; manifestDigest: string };
  bindingSetRef: BindingSetRef; skillsLibraryRef: ArtifactRef; selectedSkillRefs: ArtifactRef[];
  artifacts: FileArtifactStore; bindings: BindingStore; builder: HarnessBuilder;
  workspaceManager: CandidateWorkspaceManager; stateRoot: string; hostIdentityDigest: string;
  signal?: AbortSignal }

type Chosen = { name: string; ref: ArtifactRef; markdown: string; digest: string; path: string }
type Journal = { schemaVersion: 1; inputDigest: string; stage: 'intent' | 'workspace' | 'complete';
  workspaceId?: string; result?: SkillOverlayResult }
function evolutionId(operationId: string): string { return `algorithm-skill-overlay-${operationId}` }
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const commitPattern = /^[0-9a-f]{40}$/u
function sha256(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }
function exactKeys(value: object, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }

/** A started workspace whose final Git effect cannot be inspected must keep its original operation pending. */
export class SkillOverlayUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'SkillOverlayUnknown' }
}

function readBody(artifacts: FileArtifactStore, ref: ArtifactRef, name: string): Chosen {
  if (ref.schemaId !== 'skills.body.v1' || ref.mediaType !== 'application/json')
    throw new Error('Selected skill body schema mismatch')
  const value = artifacts.getJson(ref) as unknown as SkillBody
  if (!value || value.schemaVersion !== 1 || typeof value.markdown !== 'string'
    || !exactKeys(value, ['schemaVersion', 'markdown'])) throw new Error('Invalid skill body artifact')
  const markdown = value.markdown
  if (Buffer.byteLength(markdown, 'utf8') > 256 * 1024 || markdown.includes('\0') || !markdown.startsWith('---\n'))
    throw new Error('Invalid single-file Skill content')
  const end = markdown.indexOf('\n---\n', 4)
  if (end < 0 || end > 32 * 1024) throw new Error('Skill frontmatter is missing or too large')
  const frontmatter: unknown = loadYaml(markdown.slice(4, end))
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter))
    throw new Error('Skill frontmatter must be a mapping')
  const header = frontmatter as Record<string, unknown>
  if (header.name !== name || typeof header.description !== 'string' || !header.description.trim())
    throw new Error('Skill frontmatter name/description does not match library')
  return { name, ref, markdown, digest: sha256(markdown), path: `skills/${name}/SKILL.md` }
}

type SkillSelection = Pick<SkillOverlayInput, 'baseHarness' | 'bindingSetRef' | 'skillsLibraryRef'
  | 'selectedSkillRefs' | 'artifacts' | 'bindings'>
function chosen(input: SkillSelection): Chosen[] {
  const slots = input.bindings.read(input.bindingSetRef).slots
  const harnessRef = slots.harness, libraryRef = slots.skills
  if (!harnessRef || !libraryRef || canonicalJson(libraryRef) !== canonicalJson(input.skillsLibraryRef)
    || harnessRef.schemaId !== 'harness.directory.v1' || libraryRef.schemaId !== 'skills.library.v1')
    throw new Error('Skill overlay must use the bound harness and library')
  const harness = input.artifacts.getJson(harnessRef) as Record<string, unknown>
  if (harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
    || harness.commitOid !== input.baseHarness.commitOid || harness.manifestDigest !== input.baseHarness.manifestDigest)
    throw new Error('Skill overlay base harness differs from the bound version')
  const library = input.artifacts.getJson(libraryRef) as unknown as SkillsLibrary
  if (!library || library.schemaVersion !== 1 || !Array.isArray(library.skills)
    || !exactKeys(library, ['schemaVersion', 'skills'])) throw new Error('Invalid skills.library.v1 artifact')
  const members = new Map<string, { name: string; contentRef: ArtifactRef }>()
  let lastName = ''
  for (const entry of library.skills) {
    if (!entry || typeof entry !== 'object' || !exactKeys(entry, ['name', 'contentRef'])
      || typeof entry.name !== 'string' || !namePattern.test(entry.name)
      || entry.name <= lastName || !entry.contentRef || entry.contentRef.schemaId !== 'skills.body.v1')
      throw new Error('Skills library entries must be unique, sorted, and typed')
    lastName = entry.name
    const key = canonicalJson(entry.contentRef)
    if (members.has(key)) throw new Error('Skills library repeats a body reference')
    members.set(key, entry)
  }
  const selected: Chosen[] = [], seen = new Set<string>()
  for (const ref of input.selectedSkillRefs) {
    const key = canonicalJson(ref), entry = members.get(key)
    if (!entry || seen.has(key)) throw new Error('Selected Skill is absent from the bound library or repeated')
    seen.add(key)
    selected.push(readBody(input.artifacts, ref, entry.name))
  }
  return selected.sort((a, b) => a.name.localeCompare(b.name))
}

/** Pure bound-library/member validation for a provider's admission path. */
export function validateSkillOverlaySelection(input: SkillSelection): { injectedSkillDigests: string[] } {
  return { injectedSkillDigests: chosen(input).map(skill => skill.ref.digest) }
}

function checkReport(report: CandidateCheckReport, skills: Chosen[]): void {
  if (!report.ok || report.runtime.skillDiscovery.status !== 'passed' || report.runtime.skillRead.status !== 'passed')
    throw new Error('Harness Skill discovery/read was not confirmed by the configured runtime checker')
  for (const skill of skills) {
    if (!report.runtime.skills?.some(item => item.name === skill.name && item.read === 'passed'
      && item.provider === 'filesystem' && item.contentDigest === skill.digest && item.path === skill.path))
      throw new Error(`Harness runtime did not read injected Skill ${skill.name}`)
  }
}

async function writeSkill(handle: CandidateWorkspaceHandle, skill: Chosen): Promise<void> {
  const skillsDirectory = join(handle.targetPath, 'skills')
  const skillDirectory = join(skillsDirectory, skill.name)
  const path = join(handle.targetPath, ...skill.path.split('/'))
  for (const directory of [skillsDirectory, skillDirectory]) {
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory)
      throw new Error('Skill overlay directory is redirected')
  }
  const existed = existsSync(path)
  if (existed) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Skill overlay path is not an owned regular file')
    const previous = await readFile(path, 'utf8')
    if (previous === skill.markdown) return
  }
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW
    | (existed ? 0 : constants.O_CREAT | constants.O_EXCL)
  const file = await open(path, flags, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Skill overlay path is not an owned regular file')
    await file.truncate(0)
    await file.writeFile(skill.markdown, 'utf8')
    await file.sync()
  } finally { await file.close() }
}

/** Reattach only the operation's own open workspace; ambiguous or finalized effects are never replayed. */
async function findWorkspace(input: SkillOverlayInput): Promise<string | null> {
  const root = resolve(input.workspaceManager.options.rootForEvolution(evolutionId(input.operationId)))
  if (!existsSync(root)) return null
  const matches: Array<{ id: string; state: string }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('workspace-')) continue
    let value: Record<string, unknown>
    try { value = JSON.parse(await readFile(join(root, entry.name, 'workspace.json'), 'utf8')) as Record<string, unknown> }
    catch { throw new SkillOverlayUnknown('Skill workspace sidecar cannot be inspected') }
    if (value.evolutionId === evolutionId(input.operationId) && value.roundId === input.operationId) {
      if (typeof value.workspaceId !== 'string' || typeof value.state !== 'string'
        || value.parentRef !== input.baseHarness.commitOid || value.parentDigest !== input.baseHarness.manifestDigest)
        throw new SkillOverlayUnknown('Skill workspace sidecar identity is uncertain')
      matches.push({ id: value.workspaceId, state: value.state })
    }
  }
  if (matches.length > 1 || matches.some(match => match.state !== 'open'))
    throw new SkillOverlayUnknown('Skill workspace effect is unresolved')
  return matches[0]?.id ?? null
}

/** Materialize bound single-file Skills into an isolated real Git harness and seal the checked version. */
export async function materializeSkillOverlay(input: SkillOverlayInput): Promise<SkillOverlayResult> {
  assertDigest(input.operationId); assertDigest(input.hostIdentityDigest)
  if (!commitPattern.test(input.baseHarness.commitOid) || !/^sha256:[0-9a-f]{64}$/u.test(input.baseHarness.manifestDigest))
    throw new Error('Invalid base harness identity')
  if (resolve(input.builder.repositoryPath) !== resolve(input.workspaceManager.options.repositoryPath)
    || input.builder.targetRoot !== input.workspaceManager.options.targetRoot)
    throw new Error('Skill overlay builder/workspace source mismatch')
  const skills = chosen(input)
  const manifest = await input.builder.readManifest(input.baseHarness.commitOid)
  if (manifest.digest !== input.baseHarness.manifestDigest) throw new Error('Skill overlay base manifest drift')
  const inputDigest = jsonDigest({ operationId: input.operationId, baseHarness: input.baseHarness,
    bindingSetRef: input.bindingSetRef, skillsLibraryRef: input.skillsLibraryRef,
    selectedSkillRefs: input.selectedSkillRefs, hostIdentityDigest: input.hostIdentityDigest,
    implementationDigest: implementationClosureDigest(['providers/skill-overlay'], {
      builder: { repositoryPath: input.builder.repositoryPath, targetRoot: input.builder.targetRoot,
        toolchainRef: input.builder.options.toolchainRef, sandboxProfileRef: input.builder.options.sandboxProfileRef },
      workspace: { repositoryPath: input.workspaceManager.options.repositoryPath,
        targetRoot: input.workspaceManager.options.targetRoot, maxFiles: input.workspaceManager.options.maxFiles,
        maxBytes: input.workspaceManager.options.maxBytes, maxDiffBytes: input.workspaceManager.options.maxDiffBytes,
        allowedPathGrantDigest: input.workspaceManager.allowedPathGrantDigest },
      hostIdentityDigest: input.hostIdentityDigest }) })
  const store = new CampaignStore<JsonValue>(join(input.stateRoot, 'skill-overlay', input.operationId))
  const signal = input.signal ?? new AbortController().signal
  return store.withWriter(async () => {
    let journal = store.load()?.state as Journal | undefined
    if (journal && (!['intent', 'workspace', 'complete'].includes(journal.stage)
      || (journal.stage === 'workspace' && typeof journal.workspaceId !== 'string')
      || (journal.stage === 'complete' && !journal.result)))
      throw new Error('Skill overlay journal state is corrupt')
    if (journal && (journal.schemaVersion !== 1 || journal.inputDigest !== inputDigest))
      throw new Error('Skill overlay operation input or implementation drift')
    if (journal?.stage === 'complete') {
      if (!journal.result) throw new Error('Skill overlay completion record is corrupt')
      input.artifacts.getJson(journal.result.receiptRef)
      const sealed = await input.builder.readManifest(journal.result.commitOid)
      if (sealed.digest !== journal.result.manifestDigest) throw new Error('Sealed Skill overlay changed')
      return journal.result
    }
    if (!journal) {
      journal = { schemaVersion: 1, inputDigest, stage: 'intent' }
      await store.commit(journal as unknown as JsonValue, 'intent')
    }
    if (skills.length === 0) {
      const receiptRef = input.artifacts.putJson({ schemaVersion: 1, operationId: input.operationId, inputDigest,
        baseHarness: input.baseHarness, bindingSetDigest: input.bindingSetRef.digest,
        skillsLibraryDigest: input.skillsLibraryRef.digest, injectedSkillDigests: [], paths: [],
        commitOid: input.baseHarness.commitOid, manifestDigest: input.baseHarness.manifestDigest } as JsonValue,
      'skills.overlay.receipt.v1')
      const result = { commitOid: input.baseHarness.commitOid, manifestDigest: input.baseHarness.manifestDigest,
        injectedSkillDigests: [], receiptRef }
      await store.commit({ ...journal, stage: 'complete', result } as unknown as JsonValue, 'complete')
      return result
    }
    const request = { evolutionId: evolutionId(input.operationId), roundId: input.operationId,
      parentHarnessRef: input.baseHarness.commitOid, parentHarnessDigest: input.baseHarness.manifestDigest }
    const foundId = journal.workspaceId ?? await findWorkspace(input)
    let handle: CandidateWorkspaceHandle
    if (foundId) {
      try { handle = await input.workspaceManager.restore(foundId, request) }
      catch { throw new SkillOverlayUnknown('Skill workspace cannot be safely reattached') }
    } else handle = await input.workspaceManager.create(request, signal)
    if (journal.workspaceId && journal.workspaceId !== handle.workspaceId)
      throw new SkillOverlayUnknown('Skill workspace ownership changed')
    if (journal.stage !== 'workspace') {
      journal = { ...journal, stage: 'workspace', workspaceId: handle.workspaceId }
      await store.commit(journal as unknown as JsonValue, 'workspace')
    }
    for (const skill of skills) await writeSkill(handle, skill)
    const checked = await input.builder.checkWorkspace(handle, signal)
    checkReport(checked, skills)
    const sealed = await input.workspaceManager.seal(handle.workspaceId, signal)
    input.workspaceManager.markFinalizing(handle.workspaceId)
    await input.workspaceManager.verifySealed(handle.workspaceId, sealed, signal)
    const prepared = await input.builder.finalizeWorkspace(handle, sealed, signal)
    if (!prepared.validation) throw new Error('Finalized harness omitted Skill runtime validation')
    checkReport(prepared.validation, skills)
    if (prepared.validation.runtime.candidateDigest !== prepared.digest)
      throw new Error('Finalized Skill runtime report was for a different harness version')
    await input.workspaceManager.markCommitted(handle.workspaceId)
    const result: SkillOverlayResult = { commitOid: prepared.ref, manifestDigest: prepared.digest,
      injectedSkillDigests: skills.map(skill => skill.ref.digest),
      receiptRef: input.artifacts.putJson({ schemaVersion: 1, operationId: input.operationId, inputDigest,
        baseHarness: input.baseHarness, bindingSetDigest: input.bindingSetRef.digest,
        skillsLibraryDigest: input.skillsLibraryRef.digest,
        injectedSkillDigests: skills.map(skill => skill.ref.digest), paths: skills.map(skill => skill.path),
        contentDigests: skills.map(skill => skill.digest), checkDigest: jsonDigest(prepared.validation as unknown as JsonValue),
        commitOid: prepared.ref, manifestDigest: prepared.digest } as JsonValue, 'skills.overlay.receipt.v1') }
    await store.commit({ ...journal, stage: 'complete', result } as unknown as JsonValue, 'complete')
    await input.workspaceManager.dispose(handle.workspaceId)
    return result
  })
}
