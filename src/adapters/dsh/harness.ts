import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { HarnessAdapter, MutationPolicy } from '../../ports/harness.js'

export const dshMutationPolicy: MutationPolicy = {
  writableRoots: ['preset', 'plugins', 'prompts', 'skills', 'workflows'],
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
  allowedImports: ['@deepseek-ai/', 'node:'],
}
export class DshHarnessAdapter implements HarnessAdapter {
  readonly mutationPolicy = dshMutationPolicy
  describe() {
    return {
      adapterRef: { id: 'dsh', version: '1' },
      resources: ['rules', 'skills', 'plugins', 'workflows', 'configuration'],
      guide:
        'Edit Cordis composition in preset/agent.cordis.yml, prompts, skills and plugin hooks. Dependency manifests are fixed.',
      runtimeSourceMutation: false,
    }
  }
  async prepare(directory: string): Promise<void> {
    await mkdir(join(directory, 'preset'), { recursive: true })
    await mkdir(join(directory, 'prompts'), { recursive: true })
    await mkdir(join(directory, 'plugins'), { recursive: true })
    await writeFile(
      join(directory, 'preset/agent.cordis.yml'),
      '- id: gear-policy\n  name: ../plugins/policy.js\n',
      { flag: 'wx' },
    )
    await writeFile(
      join(directory, 'plugins/policy.js'),
      `import { readFileSync } from 'node:fs'
export const name = 'gear-policy'
export const inject = ['systemPrompt']
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'harness:gear-policy', order: 50,
    text: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8') })
}
`,
      { flag: 'wx' },
    )
    await writeFile(
      join(directory, 'prompts/system.md'),
      'Follow the task instruction. Produce only the requested output.\n',
      { flag: 'wx' },
    )
  }
  async check(directory: string): Promise<void> {
    const parsed: unknown = load(await readFile(join(directory, 'preset/agent.cordis.yml'), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('preset/agent.cordis.yml must contain a Cordis row list')
    for (const [index, row] of parsed.entries()) {
      if (!row || typeof row !== 'object' || typeof row.name !== 'string')
        throw new Error(`preset row ${index + 1} must name a plugin`)
    }
  }
  executionSpec(directory: string) {
    return {
      harnessId: 'dsh',
      workingDirectory: directory,
      entrypoint: 'preset/agent.cordis.yml',
      resourcePaths: [...this.mutationPolicy.writableRoots],
    }
  }
  async materialize(directory: string, environment: string) {
    await cp(directory, join(environment, 'gear-target'), { recursive: true })
    await writeFile(
      join(environment, 'gear-target.patch.yml'),
      `- id: hmr
  disabled: false
  config: { root: [] }
- id: sandbox-policy
  config: { mode: danger-full-access, workspaceRoot: /app }
- id: approval
  config: { policy: never }
- id: skill-filesystem
  config:
    customSkillDirs: [/opt/gear-target/skills]
- insert:
    - id: gear-target-resources
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: /opt/gear-target/preset/agent.cordis.yml
`,
    )
    return {
      // Harbor owns the container boundary. Nested host sandbox backends are
      // unavailable there; this fixed patch is never part of a host carrier.
      dockerfile:
        'COPY gear-target/ /opt/gear-target/\nCOPY gear-target.patch.yml /opt/gear-target.patch.yml\n',
      agentArgs: ['--patch', '/opt/gear-target.patch.yml'],
    }
  }
}
