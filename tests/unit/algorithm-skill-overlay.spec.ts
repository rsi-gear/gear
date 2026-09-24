import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { ArtifactRef, BindingSchema } from '../../src/algorithm/contracts.js'
import { materializeSkillOverlay, SkillOverlayUnknown, validateSkillOverlaySelection,
  type SkillOverlayInput } from '../../src/algorithm/providers/skill-overlay.js'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { HarnessBuilder, type HarnessCompiler } from '../../src/harness/builder.js'
import type { CompilerCheckReport } from '../../src/harness/check-report.js'
import type { HarnessManifest } from '../../src/types.js'
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const bindingSchema: BindingSchema = { id: 'skill-overlay-fixture.v1', slots: {
  harness: { schemaId: 'harness.directory.v1', required: true, replaceable: false },
  skills: { schemaId: 'skills.library.v1', required: true, replaceable: true },
} }
const markdown = '---\nname: verify-change\ndescription: Verify a change using focused checks.\n---\n\n# Verify Change\n\nRun the focused check.\n'
const contentDigest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`

class PhysicalSkillCheck implements HarnessCompiler {
  readonly runtimeValidation = true
  constructor(readonly expected: string, readonly reportRead = true) {}
  async compile(worktree: string, _signal: AbortSignal, manifest?: HarnessManifest): Promise<CompilerCheckReport> {
    const path = join(worktree, 'harness', 'skills', 'verify-change', 'SKILL.md')
    const actual = await readFile(path, 'utf8')
    if (actual !== this.expected) throw new Error('Skill bytes in real worktree differ from selected artifact')
    const passed = { status: 'passed' as const }
    return { ok: true, status: 'passed', runtime: { schemaVersion: 1,
      candidateDigest: manifest!.digest, identity: { name: 'fixture-runtime', version: '1', lockDigest: digestJson('runtime') },
      load: passed, promptAssembly: passed,
      skillDiscovery: this.reportRead ? { status: 'passed', checked: 1, expected: 1 } : { status: 'not_checked' },
      skillRead: this.reportRead ? { status: 'passed', checked: 1, expected: 1 } : { status: 'not_checked' },
      cleanup: passed,
      skills: this.reportRead ? [{ name: 'verify-change', path: 'skills/verify-change/SKILL.md',
        provider: 'filesystem', contentDigest: contentDigest(actual), read: 'passed' }] : [] } }
  }
}

async function setup(reportRead = true) {
  const fixture = await createGitHarnessFixture(); roots.push(fixture.root)
  const stateRoot = await mkdtemp(join(tmpdir(), 'gear-skill-overlay-state-')); roots.push(stateRoot)
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'))
  const bindings = new BindingStore(artifacts, bindingSchema)
  const harnessRef = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: fixture.championRef,
    manifestDigest: fixture.manifest.digest }, 'harness.directory.v1')
  const bodyRef = artifacts.putJson({ schemaVersion: 1, markdown }, 'skills.body.v1')
  const libraryRef = artifacts.putJson({ schemaVersion: 1, skills: [{ name: 'verify-change', contentRef: bodyRef }] }, 'skills.library.v1')
  const bindingSetRef = bindings.create({ harness: harnessRef, skills: libraryRef })
  const builder = new HarnessBuilder({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    dshBaseRef: fixture.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new PhysicalSkillCheck(markdown, reportRead) })
  const workspaceOptions = { repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    rootForEvolution: (id: string) => join(stateRoot, 'workspaces', id),
    maxFiles: 4, maxBytes: 100_000, maxDiffBytes: 100_000 }
  const workspaceManager = new CandidateWorkspaceManager(workspaceOptions)
  await workspaceManager.initialize(); await builder.initialize()
  const input: SkillOverlayInput = { operationId: digestJson('skill-overlay-fixture').slice(7),
    baseHarness: { commitOid: fixture.championRef, manifestDigest: fixture.manifest.digest },
    bindingSetRef, skillsLibraryRef: libraryRef, selectedSkillRefs: [bodyRef],
    artifacts, bindings, builder, workspaceManager, stateRoot,
    hostIdentityDigest: digestJson('fixture-host').slice(7) }
  return { fixture, stateRoot, artifacts, bindings, builder, workspaceOptions, input, bodyRef, libraryRef }
}

describe('physical Skill overlay', () => {
  it('checks bound library membership without creating a workspace or operation record', async () => {
    const f = await setup()
    expect(validateSkillOverlaySelection(f.input)).toEqual({ injectedSkillDigests: [f.bodyRef.digest] })
    expect(await readdir(f.stateRoot)).toEqual(['artifacts'])
  })

  it('injects exact library bytes into the DSH-recognized path, checks them, seals Git, and restarts idempotently', async () => {
    const f = await setup()
    const result = await materializeSkillOverlay(f.input)
    expect(result.commitOid).not.toBe(f.fixture.championRef)
    expect(result.injectedSkillDigests).toEqual([f.bodyRef.digest])
    expect((await f.builder.readHarnessFile(result.commitOid, 'skills/verify-change/SKILL.md')).content).toBe(markdown)
    const receipt = f.artifacts.getJson(result.receiptRef) as Record<string, unknown>
    expect(receipt.commitOid).toBe(result.commitOid)
    expect(receipt.paths).toEqual(['skills/verify-change/SKILL.md'])
    const restarted = { ...f.input, workspaceManager: new CandidateWorkspaceManager(f.workspaceOptions) }
    expect(await materializeSkillOverlay(restarted)).toEqual(result)
    expect(gitOutput(f.fixture.repository, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('rejects a selected body not present in the exact bound library', async () => {
    const f = await setup()
    const other = f.artifacts.putJson({ schemaVersion: 1, markdown: markdown.replace('Run the focused check.', 'Run every check.') }, 'skills.body.v1')
    await expect(materializeSkillOverlay({ ...f.input, selectedSkillRefs: [other] })).rejects.toThrow(/absent from the bound library/)
    expect(gitOutput(f.fixture.repository, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('rejects a library ref different from the bound skills slot', async () => {
    const f = await setup()
    const other = f.artifacts.putJson({ schemaVersion: 1, skills: [] }, 'skills.library.v1')
    await expect(materializeSkillOverlay({ ...f.input, skillsLibraryRef: other })).rejects.toThrow(/bound harness and library/)
  })

  it('does not seal when physical runtime Skill discovery/read is unverified', async () => {
    const f = await setup(false)
    await expect(materializeSkillOverlay(f.input)).rejects.toThrow(/discovery\/read was not confirmed/)
    expect(gitOutput(f.fixture.repository, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('keeps a lost finalization result unknown and never creates a second Git candidate', async () => {
    const f = await setup()
    const original = f.builder.finalizeWorkspace.bind(f.builder)
    f.builder.finalizeWorkspace = async (...args) => {
      await original(...args)
      throw new Error('lost response after Git finalization')
    }
    await expect(materializeSkillOverlay(f.input)).rejects.toThrow(/lost response/)
    const prefix = `refs/dsh-refine/evolutions/algorithm-skill-overlay-${f.input.operationId}/candidates`
    const refs = gitOutput(f.fixture.repository, ['for-each-ref', '--format=%(refname)', prefix])
    expect(refs.split('\n').filter(Boolean)).toHaveLength(1)
    const restarted = { ...f.input, builder: new HarnessBuilder(f.builder.options),
      workspaceManager: new CandidateWorkspaceManager(f.workspaceOptions) }
    await expect(materializeSkillOverlay(restarted)).rejects.toBeInstanceOf(SkillOverlayUnknown)
    expect(gitOutput(f.fixture.repository, ['for-each-ref', '--format=%(refname)', prefix])).toBe(refs)
  })

  it('never writes through a symlinked Skill directory', async () => {
    const f = await setup()
    const outside = join(f.stateRoot, 'outside')
    await mkdir(outside)
    const original = f.input.workspaceManager.create.bind(f.input.workspaceManager)
    f.input.workspaceManager.create = async (...args) => {
      const handle = await original(...args)
      await symlink(outside, join(handle.targetPath, 'skills'))
      return handle
    }
    await expect(materializeSkillOverlay(f.input)).rejects.toThrow(/directory is redirected/)
    expect(await readdir(outside)).toEqual([])
  })

  it('fails closed on a corrupt sidecar after intent without creating another workspace', async () => {
    const f = await setup(false)
    await expect(materializeSkillOverlay(f.input)).rejects.toThrow(/discovery\/read/)
    const root = f.workspaceOptions.rootForEvolution(`algorithm-skill-overlay-${f.input.operationId}`)
    const workspaces = (await readdir(root)).filter(name => name.startsWith('workspace-'))
    expect(workspaces).toHaveLength(1)
    await writeFile(join(root, workspaces[0]!, 'workspace.json'), '{bad json')
    const restarted = { ...f.input, workspaceManager: new CandidateWorkspaceManager(f.workspaceOptions) }
    await expect(materializeSkillOverlay(restarted)).rejects.toBeInstanceOf(SkillOverlayUnknown)
    expect((await readdir(root)).filter(name => name.startsWith('workspace-'))).toHaveLength(1)
  })

  it('rejects a reused operation ID with changed selected inputs', async () => {
    const f = await setup()
    await materializeSkillOverlay(f.input)
    const changed: ArtifactRef = f.artifacts.putJson({ schemaVersion: 1,
      markdown: markdown.replace('Run the focused check.', 'Use a different instruction.') }, 'skills.body.v1')
    const changedLibrary = f.artifacts.putJson({ schemaVersion: 1,
      skills: [{ name: 'verify-change', contentRef: changed }] }, 'skills.library.v1')
    const bindingSetRef = f.bindings.derive(f.input.bindingSetRef, { skills: changedLibrary })
    await expect(materializeSkillOverlay({ ...f.input, bindingSetRef, skillsLibraryRef: changedLibrary,
      selectedSkillRefs: [changed] })).rejects.toThrow(/input or implementation drift/)
  })
})
