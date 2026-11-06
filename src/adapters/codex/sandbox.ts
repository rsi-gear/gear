import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { createAirGappedSandboxConfig, sandboxSystemReadPaths } from '../../sandbox.js'
import { GearError } from '../../domain/errors.js'
import { snapshotTarget, targetResources } from '../storage/targets.js'
import { DshHarnessAdapter } from '../dsh/harness.js'
import { PiHarnessAdapter } from '../pi/harness.js'
import { codexAuthFile } from './auth.js'
import type { describeCodex } from './identity.js'
import type { CodexJob } from './contracts.js'
import { stageExperience } from './experience.js'
import { ownCodexRoot, type CodexResources } from './cleanup.js'
import { builtinPolicy } from '../python/builtin-policy.js'
import type { Json } from '../../domain/algorithm-wire.js'

export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const contains = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return !child || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'))
}
export const codexAdapter = (id: 'dsh' | 'pi') =>
  id === 'dsh' ? new DshHarnessAdapter() : new PiHarnessAdapter()

export async function prepareSandbox(
  job: CodexJob,
  runtime: Awaited<ReturnType<typeof describeCodex>>,
  resources: CodexResources,
) {
  const { executable, codeModeHost, caCertificates } = runtime
  const { configuration: config, context, request } = job.input
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gear-meta-'))
  resources.root = await ownCodexRoot(root)
  await chmod(root, 0o700)
  const candidate = join(root, 'candidate'),
    output = join(root, 'output'),
    home = join(root, 'home')
  // The outer execution owner registers resources before preparation can fail.
  {
    for (const path of [output, home, join(home, '.codex'), join(home, 'tmp')])
      await mkdir(path, { recursive: true, mode: 0o700 })
    const parentId =
      request.operation.kind === 'generate_candidate'
        ? request.operation.parent_id!
        : request.operation.candidate_id!
    await snapshotTarget(join(context.targets, parentId), candidate)
    for (const resource of await targetResources(candidate)) {
      await chmod(join(candidate, resource.path), resource.executable ? 0o700 : 0o600)
    }
    const adapter = codexAdapter(context.targetAdapter)
    const taskIds = new Set(request.operation.task_ids)
    const experience = await stageExperience(job, root, (dispose) => {
      resources.dispose = dispose
    })
    // Scope authorization remains in the executor; Python owns the Meta task's
    // input presentation, instructions and result format.
    const meta = builtinPolicy<{ input: Json; schema: Json; prompt: string }>(
      'meta_prepare',
      {
        operation: request.operation,
        tasks: context.tasks
          .filter((task) => taskIds.has(task.id))
          .map(({ id, instruction, family }) => ({ id, instruction, family })),
        evidence: request.evidence.filter((cell) => taskIds.has(cell.task_id)),
        harness: adapter.describe(),
        mutationPolicy: adapter.mutationPolicy,
        experience: experience.input,
      },
      context.experiencePython,
    )
    await writeFile(join(root, 'input.json'), JSON.stringify(meta.input), { mode: 0o400 })
    await writeFile(join(root, 'schema.json'), JSON.stringify(meta.schema), { mode: 0o400 })
    if (config.authHome) {
      await writeFile(join(home, '.codex/auth.json'), await codexAuthFile(config.authHome), { mode: 0o600 })
    }
    const runtimePaths = [
      ...sandboxSystemReadPaths(),
      executable,
      ...(codeModeHost ? [codeModeHost] : []),
      ...experience.readPaths,
    ]
    // Listing the parent as read-only can cover its writable children when
    // bubblewrap restores mounts beneath a denied directory. Grant each input
    // and working directory explicitly so Linux keeps candidate/output writable.
    const allowRead = [
      ...runtimePaths,
      join(root, 'input.json'),
      join(root, 'schema.json'),
      candidate,
      output,
      home,
    ]
    for (const protectedPath of [
      ...context.protectedPaths,
      context.directory,
      context.targets,
      ...experience.protectedPaths,
    ]) {
      const resolved = await realpath(protectedPath)
      if (allowRead.some((path) => contains(path, resolved)))
        throw new GearError('codex-sandbox-overlap', 'Private project state overlaps the Meta read allowlist')
    }
    const policy = await createAirGappedSandboxConfig({
      linuxIsolation: config.linuxIsolation,
      allowRead,
      allowWrite: [
        output,
        home,
        ...experience.writePaths,
        ...(request.operation.kind === 'generate_candidate' ? [candidate] : []),
      ],
    })
    policy.network = {
      allowedDomains: config.allowedDomains,
      deniedDomains: config.allowedDomains.length ? [] : ['*'],
      strictAllowlist: true,
      allowUnixSockets: experience.sockets,
      allowAllUnixSockets: process.platform === 'linux' && config.linuxIsolation === 'bubblewrap-only',
      allowLocalBinding: false,
    }
    // Each operation worker owns a separate manager; no shared process-wide network policy.
    await SandboxManager.initialize(policy)
    await SandboxManager.waitForNetworkInitialization()
    if (process.platform === 'linux') {
      // The root read-deny mount otherwise hides the proxy socket binds added
      // earlier by bubblewrap. Expose only this manager's filtered bridges.
      policy.filesystem.allowRead = [
        ...(policy.filesystem.allowRead ?? []),
        ...[SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter(
          (socket): socket is string => socket !== undefined,
        ),
      ]
    }
    const args = [
      executable,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '--skip-git-repo-check',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-schema',
      join(root, 'schema.json'),
      '--output-last-message',
      join(output, 'result.json'),
      '-m',
      config.model,
      '-c',
      'project_doc_max_bytes=0',
      '-C',
      candidate,
      ...(config.reasoningEffort
        ? ['-c', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`]
        : []),
      '-',
    ]
    const wrapped = await SandboxManager.wrapWithSandboxArgv(args.map(quote).join(' '), '/bin/bash', policy)
    return {
      root,
      candidate,
      output,
      home,
      dispose: experience.dispose,
      argv: wrapped.argv,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: home,
        TMPDIR: join(home, 'tmp'),
        CODEX_HOME: join(home, '.codex'),
        ...(caCertificates ? { CODEX_CA_CERTIFICATE: caCertificates, SSL_CERT_FILE: caCertificates } : {}),
        ...(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
          ? { CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY }
          : {}),
      },
      prompt: meta.prompt,
    }
  }
}
