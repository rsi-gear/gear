// Real DSH/Pi CLI, carrier materialization, tool execution and separate template verifier.
// Build tests/fixtures/headless/Dockerfile first and set GEAR_TEST_HEADLESS_IMAGE.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'

const execute = promisify(execFile),
  source = resolve(import.meta.dirname, '..')
const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? source
const { DshHarnessAdapter } = await import(
  pathToFileURL(join(packageRoot, 'lib/adapters/dsh/harness.js')).href
)
const { PiHarnessAdapter } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/pi/harness.js')).href)
const { runtimeMatrix } = await import(
  pathToFileURL(join(packageRoot, 'lib/application/runtime-matrix.js')).href
)
const runtime = process.env.GEAR_TEST_HEADLESS_IMAGE
if (!runtime)
  throw new Error(
    'Set GEAR_TEST_HEADLESS_IMAGE to an image containing pinned DSH, Pi, Node and Python runtimes',
  )
const verifierImage = process.env.GEAR_TEST_VERIFIER_IMAGE
if (!verifierImage?.includes('@sha256:'))
  throw new Error('Set GEAR_TEST_VERIFIER_IMAGE to a pinned Python OCI image')
const adapters = (process.env.GEAR_TEST_HEADLESS_ADAPTERS ?? 'dsh,pi').split(',')
assert(adapters.length && adapters.every((name) => ['dsh', 'pi'].includes(name)))
const root = process.env.GEAR_TEST_HEADLESS_OUTPUT
  ? resolve(process.env.GEAR_TEST_HEADLESS_OUTPUT)
  : await mkdtemp(join(tmpdir(), 'gear-headless-'))
if (process.env.GEAR_TEST_HEADLESS_OUTPUT) await mkdir(root)
const prefix = 'gear-headless-' + randomUUID().slice(0, 8),
  images = [],
  containers = []
const run = async (command, args, options = {}) =>
  (
    await execute(command, args, {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    })
  ).stdout
const docker = (args) => run('docker', args)
const image = JSON.parse(await docker(['image', 'inspect', runtime, '--format', '{{json .}}']))
const imageId = image.Id,
  platform = `${image.Os}/${image.Architecture}`
assert(['linux/amd64', 'linux/arm64'].includes(platform), 'Unsupported candidate platform')
const verifier = JSON.parse(await docker(['image', 'inspect', verifierImage, '--format', '{{json .}}']))
const verifierPlatform = `${verifier.Os}/${verifier.Architecture}`
assert(['linux/amd64', 'linux/arm64'].includes(verifierPlatform), 'Unsupported verifier platform')
let prepared, loadArtifact
if (process.env.GEAR_TEST_HEADLESS_ARTIFACT_REPORT) {
  assert(
    process.env.GEAR_TEST_HITCH && process.env.GEAR_TEST_ARTIFACT_CACHE,
    'Prepared mode requires GEAR_TEST_HITCH and GEAR_TEST_ARTIFACT_CACHE',
  )
  prepared = JSON.parse(await readFile(process.env.GEAR_TEST_HEADLESS_ARTIFACT_REPORT, 'utf8'))
  const require = createRequire(await realpath(process.env.GEAR_TEST_HITCH))
  const { loadHarborArtifact } = await import(pathToFileURL(require.resolve('agent-hitch/evals')).href)
  loadArtifact = (summary) => loadHarborArtifact(process.env.GEAR_TEST_ARTIFACT_CACHE, summary)
}
const results = []
try {
  await writeFile(
    join(root, 'tasks.jsonl'),
    JSON.stringify({
      id: 'headless',
      split: 'seed',
      instruction: 'Write the requested answer.',
      expected: 'correct',
    }) + '\n',
  )
  await run(
    process.env.GEAR_PYTHON ?? 'python3',
    [
      '-c',
      `import sys
from pathlib import Path
from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor
root=Path(sys.argv[1])
benchmark=compile_benchmark(root,{"version":1,"source":"tasks.jsonl","template":"text","normalization":{"trim":True}})
compile_harbor(benchmark,str(root/"tasks"),["headless"],sys.argv[2])`,
      root,
      verifierImage,
    ],
    { env: { ...process.env, PYTHONPATH: join(packageRoot, 'python') } },
  )
  for (const [name, adapter] of [
    ['dsh', new DshHarnessAdapter()],
    ['pi', new PiHarnessAdapter()],
  ]) {
    if (!adapters.includes(name)) continue
    let artifact, manifest
    if (prepared) {
      const matches = prepared.artifacts.filter(
        (item) =>
          item.harness === runtimeMatrix.harnesses[name] &&
          item.runtime_contract.docker_platform === platform,
      )
      assert(
        matches.length > 0 && new Set(matches.map((item) => item.artifact.artifact_id)).size === 1,
        `Report lacks one matching ${name} artifact for ${platform}`,
      )
      artifact = await loadArtifact(matches[0].artifact)
      manifest = JSON.parse(await readFile(join(artifact.directory, 'artifact.json'), 'utf8'))
      assert.equal(manifest.launcher, 'node')
      assert.equal(manifest.resolved_revision.canonical_ref, runtimeMatrix.harnesses[name])
      assert(
        /^[a-zA-Z0-9_@./-]+$/.test(manifest.entrypoint) &&
          !manifest.entrypoint.startsWith('/') &&
          !manifest.entrypoint.split('/').includes('..'),
      )
    }
    const target = join(root, name, 'target')
    await adapter.prepare(target)
    for (const changed of [false, true]) {
      if (changed) {
        const path = name === 'dsh' ? 'plugins/policy.js' : '.pi/extensions/policy.ts'
        const content =
          name === 'dsh'
            ? `export const name = 'gear-policy'; export const inject = ['systemPrompt'];
export function apply(ctx) { ctx.systemPrompt.section({name:'harness:gear-policy',order:50,text:'GEAR_HEADLESS_EXTENSION_OBSERVED'}) }\n`
            : `export default function(pi) { pi.on('before_agent_start', event => ({systemPrompt:event.systemPrompt+'\\nGEAR_HEADLESS_EXTENSION_OBSERVED'})) }\n`
        await writeFile(join(target, path), content)
      }
      await adapter.check(target)
      const stage = join(root, name, changed ? 'changed' : 'baseline')
      await mkdir(stage, { recursive: true })
      const materialized = await adapter.materialize(target, stage)
      await cp(join(source, 'tests/fixtures/headless/probe.mjs'), join(stage, 'probe.mjs'))
      await writeFile(
        join(stage, 'Dockerfile'),
        `FROM ${runtime}\nWORKDIR /app\n${materialized.dockerfile}COPY probe.mjs /opt/probe.mjs\n`,
      )
      const tag = prefix + '-' + name + '-' + Number(changed)
      images.push(tag)
      await run('docker', ['build', '--platform', platform, '--tag', tag, stage], { timeout: 300000 })
      const container = tag
      containers.push(container)
      const raw = await docker([
        'run',
        '--name',
        container,
        '--platform',
        platform,
        '--network',
        'none',
        ...(artifact
          ? ['--mount', `type=bind,src=${artifact.directory},dst=/opt/hitch-artifact,readonly`]
          : []),
        '--entrypoint',
        'node',
        tag,
        '/opt/probe.mjs',
        name,
        artifact ? `/opt/hitch-artifact/${manifest.entrypoint}` : '',
        artifact ? artifact.node_version : '',
        runtimeMatrix.harnesses[name].split('@version:')[1],
      ])
      const result = JSON.parse(raw.trim())
      assert.equal(result.requests[0].marker, changed)
      const output = join(stage, 'output'),
        logs = join(stage, 'logs')
      await mkdir(output)
      await mkdir(logs)
      await docker(['cp', container + ':/app/answer.txt', join(output, 'answer.txt')])
      const verifier = tag + '-verifier'
      containers.push(verifier)
      await docker([
        'run',
        '--name',
        verifier,
        '--platform',
        verifierPlatform,
        '--network',
        'none',
        '--read-only',
        '--mount',
        `type=bind,src=${output},dst=/app,readonly`,
        '--mount',
        `type=bind,src=${join(root, 'tasks/headless/tests')},dst=/tests,readonly`,
        '--mount',
        `type=bind,src=${logs},dst=/logs/verifier`,
        '--entrypoint',
        'python3',
        verifierImage,
        '/tests/verify.py',
      ])
      const score = JSON.parse(await readFile(join(logs, 'gear-result.json'), 'utf8'))
      assert.equal(score.status, 'valid')
      assert.equal(score.value, Number(changed))
      if (artifact) await loadArtifact(artifact)
      results.push({
        ...result,
        changed,
        score,
        ...(artifact ? { prepared_artifact: { ...artifact, directory: undefined } } : {}),
      })
      console.log(JSON.stringify({ adapter: name, changed, score: score.value, native_tool_executed: true }))
    }
  }
  assert.equal(JSON.parse(await docker(['image', 'inspect', runtime, '--format', '{{json .Id}}'])), imageId)
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify(
      {
        runtime: imageId,
        platform,
        verifier_platform: verifierPlatform,
        execution: prepared ? 'hitch-prepared-artifact' : 'fixture-installation',
        adapters,
        verifier_image: verifierImage,
        results,
        external_model_requests: 0,
        network: 'none',
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ report: join(root, 'report.json'), status: 'passed', external_model_requests: 0 }),
  )
} finally {
  const failures = []
  for (const name of containers)
    try {
      await docker(['rm', '--force', name])
    } catch (error) {
      if (!String(error.stderr).includes('No such container')) failures.push(error)
    }
  for (const name of images)
    try {
      await docker(['image', 'rm', '--force', name])
    } catch (error) {
      if (!String(error.stderr).includes('No such image')) failures.push(error)
    }
  if (failures.length) throw new AggregateError(failures, 'Headless probe cleanup failed; retained ' + root)
  if (!process.env.GEAR_TEST_HEADLESS_OUTPUT) await rm(root, { recursive: true, force: true })
}
