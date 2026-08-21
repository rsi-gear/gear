import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTwoFilesPatch } from 'diff'
import {
  HarnessBuilder, MutationValidationError, NoopHarnessCompiler, SubstrateExpansionError, digestContent,
} from '../../src/harness/builder.js'
import type { HarnessMutation } from '../../src/types.js'
import { createGitHarnessFixture, gitOutput, type GitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(): Promise<{ fixture: GitHarnessFixture; builder: HarnessBuilder }> {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const builder = new HarnessBuilder({
    repositoryPath: fixture.repository,
    targetRoot: fixture.targetRoot,
    dshBaseRef: fixture.baseRef,
    toolchainRef: 'node-22-tsc',
    sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler(),
  })
  await builder.initialize()
  return { fixture, builder }
}

function mutation(fixture: GitHarnessFixture, ops: HarnessMutation['ops'], parentRef = fixture.championRef, parentDigest = fixture.manifest.digest): HarnessMutation {
  return {
    parentRef, parentDigest, target: 'context', ops,
    rationale: 'improve context', evidenceRefs: ['seed:one'], expectedOutcome: 'better score',
  }
}

describe('HarnessBuilder', () => {
  it('creates an exact clean Git commit in the complete DSH repository', async () => {
    const { builder, fixture } = await setup()
    const original = 'export const value = 1\n'
    const changed = 'export const value = 2\n'
    const prepared = await builder.build(mutation(fixture, [{
      type: 'patch', path: 'plugins/context.ts', expectedDigest: digestContent(original),
      patch: createTwoFilesPatch('a/plugins/context.ts', 'b/plugins/context.ts', original, changed),
    }, {
      type: 'create', path: 'prompts/reflection.md', content: 'Reflect after tool use.\n', expect: 'absent',
    }]), new AbortController().signal)
    expect(prepared.ref).toMatch(/^[0-9a-f]{40}$/u)
    expect(prepared.ref).not.toBe(fixture.championRef)
    expect(gitOutput(fixture.repository, ['show-ref', '--verify', `refs/dsh-refine/candidates/${prepared.ref}`])).toContain(prepared.ref)
    expect(gitOutput(fixture.repository, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(gitOutput(fixture.repository, ['show', `${prepared.ref}:harness/plugins/context.ts`])).toBe(changed.trim())
    expect((await builder.readManifest(prepared.ref)).digest).toBe(prepared.digest)
    expect((await builder.readHarnessFile(prepared.ref, 'prompts/reflection.md')).content).toBe('Reflect after tool use.\n')

    const child = await builder.build(mutation(fixture, [{
      type: 'create', path: 'prompts/child.md', content: 'second generation\n', expect: 'absent',
    }], prepared.ref, prepared.digest), new AbortController().signal)
    expect(child.manifest.parentRef).toBe(prepared.ref)
    expect(child.ref).not.toBe(prepared.ref)
  })

  it('rejects traversal, dependency changes, held-out evidence, and stale file digests', async () => {
    const { builder, fixture } = await setup()
    await expect(builder.build(mutation(fixture, [{
      type: 'create', path: '../escape.ts', content: '', expect: 'absent',
    }]), new AbortController().signal)).rejects.toBeInstanceOf(MutationValidationError)
    await expect(builder.build(mutation(fixture, [{
      type: 'create', path: 'plugins/package.json', content: '{}', expect: 'absent',
    }]), new AbortController().signal)).rejects.toBeInstanceOf(SubstrateExpansionError)
    await expect(builder.build({ ...mutation(fixture, [{
      type: 'delete', path: 'plugins/context.ts', expectedDigest: 'sha256:stale',
    }]), evidenceRefs: ['held-out:secret'] }, new AbortController().signal)).rejects.toThrow(/held-out/)
  })

  it('rejects imports outside the fixed toolchain dependency allowlist', async () => {
    const { builder, fixture } = await setup()
    await expect(builder.build(mutation(fixture, [{
      type: 'create', path: 'plugins/escape.ts', content: "import escape from 'new-untrusted-dependency'\n", expect: 'absent',
    }]), new AbortController().signal)).rejects.toBeInstanceOf(SubstrateExpansionError)
  })

  it('rejects a dirty source repository before candidate construction', async () => {
    const { builder, fixture } = await setup()
    await readFile(join(fixture.repository, 'package.json'))
    const dirty = join(fixture.repository, 'untracked.txt')
    await import('node:fs/promises').then(fs => fs.writeFile(dirty, 'dirty'))
    await expect(builder.build(mutation(fixture, [{
      type: 'create', path: 'prompts/new.md', content: 'new\n', expect: 'absent',
    }]), new AbortController().signal)).rejects.toThrow(/must be clean/)
  })

  it('rejects a commit whose manifest does not match the target bytes', async () => {
    const { builder, fixture } = await setup()
    await writeFile(join(fixture.repository, 'harness', 'plugins', 'context.ts'), 'export const value = 999\n')
    gitOutput(fixture.repository, ['add', 'harness/plugins/context.ts'])
    gitOutput(fixture.repository, ['commit', '-m', 'tamper target without updating manifest'])
    const tampered = gitOutput(fixture.repository, ['rev-parse', 'HEAD'])
    await expect(builder.readManifest(tampered)).rejects.toThrow(/integrity mismatch/)
  })
})
