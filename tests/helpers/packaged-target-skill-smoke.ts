import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect } from 'vitest'

const execute = promisify(execFile)

export async function packagedTargetSkillSmoke(lab: string, repository: string, ref: string,
  candidateDigest: string, runtimeRoot: string, skillMarkdown: string, fullHarness = false) {
  const source = join(lab, 'artifact', 'source')
  const archive = join(lab, 'candidate.tar')
  await mkdir(source, { recursive: true })
  await execute('git', ['-C', repository, 'archive', '--format=tar', `--output=${archive}`, ref])
  await execute('tar', ['-xf', archive, '-C', source])
  // Copy the installed tree with its relative pnpm symlinks, as a relocated
  // artifact. No link to the checker's profile or Gear's dev dependencies.
  await cp(join(runtimeRoot, 'node_modules'), join(source, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  const carrier = createRequire(join(source, 'package.json'))
  expect(() => carrier.resolve('@deepseek-ai/dsh-skill-filesystem')).toThrow()
  const dsh = createRequire(await realpath(carrier.resolve('@deepseek-ai/dsh/package.json')))
  expect(dsh.resolve('@deepseek-ai/dsh-skill-filesystem')).toContain(join(source, 'node_modules', '.pnpm'))
  const workspace = join(lab, 'task')
  const home = join(lab, 'cli-home')
  const reportPath = join(lab, 'cli-smoke.json')
  await mkdir(workspace)
  await mkdir(home)
  const preload = join(lab, 'block-network.mjs')
  await writeFile(preload, `globalThis.gearSmokeNetworkRequests = 0;
globalThis.fetch = () => { globalThis.gearSmokeNetworkRequests++; throw new Error('NETWORK_REQUEST_FORBIDDEN') };
`)
  const patch = join(lab, 'cli-smoke.patch.json')
  await writeFile(patch, JSON.stringify([
    // Activate HMR during boot so the real CLI can register its patch watchers
    // after the loader settles, without racing a late fallback activation.
    { id: 'hmr', disabled: false, config: { root: [] } },
    ...['headless-runner', 'headless-startup', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-5.6-luna' } },
    { insert: [{ id: 'packaged-skill-probe',
      name: pathToFileURL(join(import.meta.dirname, 'packaged-target-skill-probe.mjs')).href,
      config: { reportPath, candidateDigest, fullHarness, expectedBody: skillMarkdown.split('---\n').slice(2).join('---\n').trim() } }] },
  ]))
  const result = await execute(process.execPath, ['--import', preload, join(source, 'apps/cli/lib/bin.js'),
    '--profile', 'headless', '--patch', patch], {
    cwd: workspace, timeout: 20_000, maxBuffer: 128 * 1024,
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  })
  expect(result.stderr).not.toContain('cannot create effect on inactive context')
  expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual({ candidateDigest,
    provider: 'filesystem', discovered: true, nativeRead: true, promptAssembly: true,
    ...(fullHarness ? { customTool: true, hooks: true, workflow: true } : {}),
    sessionCwd: await realpath(workspace), networkRequests: 0 })
}
