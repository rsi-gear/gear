import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestContent } from '../../src/harness/builder.js'
import type { HarnessManifest } from '../../src/types.js'

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}

export interface GitHarnessFixture {
  root: string
  repository: string
  targetRoot: string
  baseRef: string
  championRef: string
  manifest: HarnessManifest
}

export async function createGitHarnessFixture(): Promise<GitHarnessFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-refine-git-'))
  const repository = join(root, 'dsh')
  const targetRoot = 'harness'
  await mkdir(repository, { recursive: true })
  git(repository, ['init', '--initial-branch=main'])
  git(repository, ['config', 'user.name', 'Test Author'])
  git(repository, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repository, 'package.json'), '{"name":"fixture-dsh","private":true}\n')
  git(repository, ['add', 'package.json'])
  git(repository, ['commit', '-m', 'base DSH'])
  const baseRef = git(repository, ['rev-parse', 'HEAD'])

  const harness = join(repository, targetRoot)
  await mkdir(join(harness, 'preset'), { recursive: true })
  await mkdir(join(harness, 'plugins'), { recursive: true })
  await writeFile(join(harness, 'preset', 'agent.cordis.yml'), '- name: ./plugins/context.js\n')
  await writeFile(join(harness, 'plugins', 'context.ts'), 'export const value = 1\n')
  const artifacts = []
  for (const path of ['plugins/context.ts', 'preset/agent.cordis.yml'].sort()) {
    const content = await readFile(join(harness, ...path.split('/')))
    artifacts.push({ path, digest: digestContent(content), bytes: content.byteLength })
  }
  const identity = {
    schemaVersion: 1 as const,
    dshBaseRef: baseRef,
    toolchainRef: 'node-22-tsc',
    sandboxProfileRef: 'sandbox-v1',
    artifacts,
  }
  const manifest: HarnessManifest = { ...identity, digest: digestContent(JSON.stringify(identity)) }
  await writeFile(join(harness, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  git(repository, ['add', targetRoot])
  git(repository, ['commit', '-m', 'initial target harness'])
  const championRef = git(repository, ['rev-parse', 'HEAD'])
  return { root, repository, targetRoot, baseRef, championRef, manifest }
}

export function gitOutput(repository: string, args: string[]): string {
  return git(repository, args)
}
