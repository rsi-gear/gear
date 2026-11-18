import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { sandboxSystemReadPaths } from '../../sandbox.js'
import { GearError } from '../../domain/errors.js'
import { materialPath } from '../../domain/material-path.js'
import { snapshotTarget, targetResources } from '../storage/targets.js'
import { DshHarnessAdapter } from '../dsh/harness.js'
import { PiHarnessAdapter } from '../pi/harness.js'
import type { describeCodex } from './identity.js'
import type { CodexJob } from './contracts.js'
import { stageExperience } from './experience.js'
import { ownCodexRoot, type CodexResources } from './cleanup.js'
import { builtinPolicy } from '../python/builtin-policy.js'
import type { Json } from '../../domain/algorithm-wire.js'

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
    const sourceRoot = join(root, 'sources')
    const sources: Json[] = []
    if (request.operatorCall) {
      await mkdir(sourceRoot, { mode: 0o700 })
      let bytes = 0
      for (const [index, material] of request.operatorCall.materials.entries()) {
        const path = join(sourceRoot, String(index))
        await mkdir(path, { mode: 0o700 })
        if (material.files) {
          for (const [name, file] of Object.entries(material.files)) {
            materialPath(name)
            const content = Buffer.from(file.content, 'base64')
            bytes += content.length
            if (bytes > 8 * 1024 * 1024 || content.toString('base64') !== file.content)
              throw new GearError('codex-source-size', 'Invalid or oversized source material')
            await mkdir(join(path, name, '..'), { recursive: true, mode: 0o700 })
            await writeFile(join(path, name), content, { flag: 'wx', mode: file.executable ? 0o500 : 0o400 })
          }
        } else {
          const content = JSON.stringify(material.value)
          bytes += Buffer.byteLength(content)
          if (bytes > 8 * 1024 * 1024) throw new GearError('codex-source-size', 'Oversized source material')
          await writeFile(join(path, 'value.json'), content, { flag: 'wx', mode: 0o400 })
        }
        sources.push({
          ref: material.ref,
          path: `../sources/${index}`,
          files: (material.files ? Object.keys(material.files).sort() : ['value.json']).map(
            (name) => `../sources/${index}/${name}`,
          ),
        })
      }
    }
    // Scope authorization remains in the executor; Python owns the Meta task's
    // input presentation, instructions and result format.
    const meta = builtinPolicy<{ input: Json; schema: Json; prompt: string }>(
      request.operatorCall ? 'operator_meta_prepare' : 'meta_prepare',
      {
        operation: request.operation,
        tasks: context.tasks
          .filter((task) => taskIds.has(task.id))
          .map(({ id, instruction, family }) => ({ id, instruction, family })),
        evidence: request.evidence.filter((cell) => taskIds.has(cell.task_id)),
        harness: adapter.describe(),
        mutationPolicy: adapter.mutationPolicy,
        experience: experience.input,
        ...(request.operatorCall ? { operator_call: request.operatorCall, sources } : {}),
      },
      context.experiencePython,
    )
    await writeFile(join(root, 'input.json'), JSON.stringify(meta.input), { mode: 0o400 })
    await writeFile(join(root, 'schema.json'), JSON.stringify(meta.schema), { mode: 0o400 })
    const runtimePaths = sandboxSystemReadPaths()
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
      ...experience.readPaths,
      ...(request.operatorCall ? [sourceRoot] : []),
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
    const runRequest = {
      harness_ref: 'codex@installed',
      model: config.model,
      cwd: candidate,
      workspace_mode: 'shared',
      prompt: meta.prompt,
      timeout_ms: config.timeoutMs,
      agent_args: [],
      ...(request.generationLimits ? { generation_budget: request.generationLimits } : {}),
      isolation: {
        executable_sha256: runtime.binaryDigest,
        read_paths: allowRead.filter((path) => !runtimePaths.includes(path)),
        write_paths: [
          output,
          ...experience.writePaths,
          ...(request.operation.kind === 'generate_candidate' ? [candidate] : []),
        ],
        unix_sockets: experience.sockets,
        allowed_domains: config.allowedDomains,
        output_schema: join(root, 'schema.json'),
        output_file: join(output, 'result.json'),
        ...(config.linuxIsolation ? { linux_isolation: config.linuxIsolation } : {}),
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      },
    }
    const requestPath = join(root, 'hitch-request.json')
    await writeFile(requestPath, JSON.stringify(runRequest), { mode: 0o400 })
    return {
      root,
      candidate,
      output,
      home,
      dispose: experience.dispose,
      requestPath,
      argv: [
        runtime.hitch.executable,
        '--root',
        runtime.hitch.root,
        'run',
        '--request-file',
        requestPath,
        '--output',
        'json',
        '--watch-stdin',
      ],
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        HITCH_CODEX_PATH: runtime.executable,
        ...Object.fromEntries(
          ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].flatMap((name) =>
            process.env[name] ? [[name, process.env[name]]] : [],
          ),
        ),
        ...(config.authHome ? { HITCH_CODEX_AUTH_HOME: config.authHome } : {}),
        ...(context.experiencePython ? { HITCH_GUARD_PYTHON: context.experiencePython } : {}),
        ...(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
          ? { CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY }
          : {}),
      },
    }
  }
}
