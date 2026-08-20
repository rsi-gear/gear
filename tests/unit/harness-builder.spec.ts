import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTwoFilesPatch } from 'diff'
import {
  HarnessBuilder, MutationValidationError, NoopHarnessCompiler, digestContent,
} from '../../src/harness/builder.js'
import type { HarnessMutation } from '../../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<{ root: string; builder: HarnessBuilder; parentDigest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'refine-builder-'))
  roots.push(root)
  const parent = join(root, 'harnesses', 'parent')
  await mkdir(join(parent, 'preset'), { recursive: true })
  await mkdir(join(parent, 'plugins'), { recursive: true })
  await writeFile(join(parent, 'preset', 'agent.cordis.yml'), '- name: ./plugins/context.js\n')
  await writeFile(join(parent, 'plugins', 'context.ts'), 'export const value = 1\n')
  const parentDigest = 'sha256:parent'
  await writeFile(join(parent, 'manifest.json'), JSON.stringify({ schemaVersion: 1, digest: parentDigest, artifacts: [] }))
  return {
    root,
    parentDigest,
    builder: new HarnessBuilder({
      harnessRoot: join(root, 'harnesses'), artifactRoot: join(root, 'artifacts'),
      dshRevision: 'dsh-rc8', toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler(),
    }),
  }
}

function mutation(parentDigest: string, ops: HarnessMutation['ops'], parentRef = 'parent'): HarnessMutation {
  return {
    parentRef, parentDigest, target: 'context', ops,
    rationale: 'improve context', evidenceRefs: ['seed:one'], expectedOutcome: 'better score',
  }
}

describe('HarnessBuilder', () => {
  it('applies CAS operations and creates an immutable content-addressed artifact', async () => {
    const { builder, parentDigest } = await fixture()
    const original = 'export const value = 1\n'
    const changed = 'export const value = 2\n'
    const prepared = await builder.build(mutation(parentDigest, [{
      type: 'patch', path: 'plugins/context.ts', expectedDigest: digestContent(original),
      patch: createTwoFilesPatch('a/plugins/context.ts', 'b/plugins/context.ts', original, changed),
    }, {
      type: 'create', path: 'prompts/reflection.md', content: 'Reflect after tool use.\n', expect: 'absent',
    }]), new AbortController().signal)
    expect(prepared.ref).toBe(prepared.digest)
    expect(prepared.manifest.artifacts.map(item => item.path)).toContain('prompts/reflection.md')
    expect(await readFile(join(prepared.artifactPath, 'plugins', 'context.ts'), 'utf8')).toBe(changed)
    expect(JSON.parse(await readFile(join(prepared.artifactPath, 'manifest.json'), 'utf8'))).toMatchObject({
      digest: prepared.digest, parentRef: 'parent', sandboxProfileRef: 'sandbox-v1',
    })
    const child = await builder.build(mutation(prepared.digest, [{
      type: 'create', path: 'prompts/child.md', content: 'second generation\n', expect: 'absent',
    }], prepared.ref), new AbortController().signal)
    expect(child.manifest.parentRef).toBe(prepared.ref)
    expect(child.ref).not.toBe(prepared.ref)
  })

  it('rejects traversal, dependency changes, held-out evidence, and stale file digests', async () => {
    const { builder, parentDigest } = await fixture()
    await expect(builder.build(mutation(parentDigest, [{
      type: 'create', path: '../escape.ts', content: '', expect: 'absent',
    }]), new AbortController().signal)).rejects.toBeInstanceOf(MutationValidationError)
    await expect(builder.build(mutation(parentDigest, [{
      type: 'create', path: 'plugins/package.json', content: '{}', expect: 'absent',
    }]), new AbortController().signal)).rejects.toThrow(/fixed substrate/)
    await expect(builder.build({ ...mutation(parentDigest, [{
      type: 'delete', path: 'plugins/context.ts', expectedDigest: 'sha256:stale',
    }]), evidenceRefs: ['held-out:secret'] }, new AbortController().signal)).rejects.toThrow(/held-out/)
  })

  it('rejects imports outside the fixed toolchain dependency allowlist', async () => {
    const { builder, parentDigest } = await fixture()
    await expect(builder.build(mutation(parentDigest, [{
      type: 'create', path: 'plugins/escape.ts', content: "import escape from 'new-untrusted-dependency'\n", expect: 'absent',
    }]), new AbortController().signal)).rejects.toThrow(/dependency allowlist/)
  })
})
