import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessAdapter, MutationPolicy } from '../../ports/harness.js'

export const piMutationPolicy: MutationPolicy = {
  writableRoots: ['AGENTS.md', '.pi/settings.json', '.pi/extensions', '.pi/skills', '.pi/prompts'],
  protectedNames: [
    'manifest.json',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    '.git',
  ],
  allowedImports: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-tui',
    '@sinclair/typebox',
    'node:',
  ],
}
export class PiHarnessAdapter implements HarnessAdapter {
  readonly mutationPolicy = piMutationPolicy
  describe() {
    return {
      adapterRef: { id: 'pi', version: '1' },
      resources: ['rules', 'skills', 'extensions', 'prompts', 'configuration'],
      guide:
        'Edit AGENTS.md and project-local .pi resources. Extensions export a default function accepting ExtensionAPI; dependencies and the upstream runtime are fixed.',
      runtimeSourceMutation: false,
    }
  }
  async prepare(directory: string): Promise<void> {
    for (const path of ['.pi/extensions', '.pi/skills', '.pi/prompts'])
      await mkdir(join(directory, path), { recursive: true })
    await writeFile(
      join(directory, 'AGENTS.md'),
      'Follow the task instruction. Produce only the requested output.\n',
      { flag: 'wx' },
    )
    await writeFile(join(directory, '.pi/settings.json'), '{}\n', { flag: 'wx' })
  }
  async check(directory: string): Promise<void> {
    const settings: unknown = JSON.parse(await readFile(join(directory, '.pi/settings.json'), 'utf8'))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('.pi/settings.json must be an object')
    // External resource paths would escape the frozen candidate and its mutation policy.
    for (const field of ['packages', 'extensions', 'skills', 'prompts', 'themes']) {
      if (field in settings)
        throw new Error(`Pi ${field} must use the sealed project-local discovery directories`)
    }
    await readFile(join(directory, 'AGENTS.md'), 'utf8')
  }
  executionSpec(directory: string) {
    return {
      harnessId: 'pi',
      workingDirectory: directory,
      entrypoint: '.pi',
      resourcePaths: [...this.mutationPolicy.writableRoots],
    }
  }
  async materialize(directory: string, environment: string) {
    await cp(directory, join(environment, 'gear-target'), { recursive: true })
    // Pi's native project discovery uses /app/.pi and /app/AGENTS.md.
    return { dockerfile: 'COPY gear-target/ /app/\n', agentArgs: ['--approve', '--offline'] }
  }
}
