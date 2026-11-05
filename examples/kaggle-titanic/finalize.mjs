#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { readFile, writeFile, mkdir, copyFile, constants, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicJson, cli, command, hash, hitchJson, identity, isMain, readJson, requireArtifacts, validateSubmission } from './common.mjs'

const gitFile = promisify(execFile)
const mutable = path => /^workflows\/titanic\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:py|json)$/u.test(path)

/** Validate the selected immutable git tree, including the fixed carrier, before admission. */
export async function selectedCandidate(project, commit, expectedDigest) {
  const git = args => command('git', args, { cwd: project.targetRepository })
  const manifest = JSON.parse(await git(['show', `${commit}:harness/manifest.json`]))
  const { digest, ...body } = manifest
  if (manifest.schemaVersion !== 1 || digest !== expectedDigest || hash(JSON.stringify(body)) !== digest
    || manifest.dshBaseRef !== project.dshBaseRef || !/^[a-f0-9]{40}$/u.test(project.dshBaseRef)
    || manifest.toolchainRef !== 'kaggle-dsh-cpu-v1' || manifest.sandboxProfileRef !== 'kaggle-chroot-v1'
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 10000) throw new Error('selected candidate manifest mismatch')
  await git(['merge-base', '--is-ancestor', project.dshBaseRef, commit])
  const changed = (await git(['diff', '--name-only', '-z', project.dshBaseRef, commit, '--'])).split('\0').filter(Boolean)
  if (changed.some(path => path !== 'harness/manifest.json' && (!path.startsWith('harness/') || !mutable(path.slice(8))))) {
    throw new Error('selected candidate changed the fixed carrier')
  }
  const files = (await git(['ls-tree', '-r', '-z', commit, '--', 'harness/'])).split('\0').filter(Boolean).map(row => {
    const [meta, path] = row.split('\t')
    if (!/^(100644|100755) blob /u.test(meta) || !path?.startsWith('harness/')) throw new Error('unsafe candidate source tree')
    return path.slice(8)
  }).filter(path => path !== 'manifest.json')
  const declared = new Set()
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry.path !== 'string' || (!mutable(entry.path) && entry.path !== 'preset/agent.cordis.yml')
      || declared.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 16 * 1024 * 1024) throw new Error('invalid candidate source entry')
    declared.add(entry.path)
    const { stdout } = await gitFile('git', ['show', `${commit}:harness/${entry.path}`], { cwd: project.targetRepository, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
    if (stdout.length !== entry.bytes || hash(stdout) !== entry.digest) throw new Error('selected candidate source digest mismatch')
    if (entry.path === 'preset/agent.cordis.yml' && stdout.toString('utf8').replace(/^\s*#.*$/gm, '').trim() !== '[]') throw new Error('candidate preset must stay empty')
  }
  if (files.length !== declared.size || files.some(path => !declared.has(path)) || !declared.has('workflows/titanic/pipeline.py')) throw new Error('incomplete candidate source manifest')
  return manifest
}

export async function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: { project: { type: 'string' }, commit: { type: 'string' },
    'manifest-digest': { type: 'string' }, out: { type: 'string' }, 'retry-unstarted': { type: 'boolean' } } })
  if (!v.project || !v.out || !/^[a-f0-9]{40}$/u.test(v.commit ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(v['manifest-digest'] ?? '')) {
    throw new Error('--project, --out, exact --commit and --manifest-digest are required')
  }
  const directory = resolve(v.project)
  let out = resolve(v.out)
  const project = await readJson(join(directory, 'project.json')), config = await readJson(join(directory, 'gear.config.json'))
  await requireArtifacts(config)
  if (hash(await readFile(project.competitionFile)) !== project.competitionDigest) throw new Error('competition configuration changed')
  const competition = await readJson(project.competitionFile)
  if (config.hitch.sampling?.temperature !== undefined) throw new Error('Hitch finalization does not support sampling.temperature')
  const manifest = await selectedCandidate(project, v.commit, v['manifest-digest'])
  const digest = manifest.digest
  const dataset = await readJson(join(project.finalizationRef, 'benchmark.adapter.json'))
  if (dataset.tasks.length !== 1 || dataset.tasks[0].task_id !== 'titanic-finalize') throw new Error('invalid finalization dataset')
  const harness = `deepseek@git+${pathToFileURL(project.targetRepository).href}#${v.commit}`
  const inputs = { candidateCommit: v.commit, candidateManifest: digest, competitionDigest: project.competitionDigest,
    datasetDigest: dataset.dataset_digest, harness, model: config.hitch.model, taskBudgetMs: config.taskBudgetMs,
    setupTimeoutMs: config.hitch.setupTimeoutMs, sampling: config.hitch.sampling, agentArgs: config.hitch.agentArgs,
    passEnv: config.hitch.passEnv, hitchRoot: resolve(config.hitch.root),
    // Identity includes CLI bytes; replacing a wrapper/runtime requires a new finalization.
    executableDigest: hash(await readFile(config.hitch.executable)) }
  const inputDigest = identity(inputs)
  await mkdir(out, { recursive: true })
  out = await realpath(out)
  const intentFile = join(out, 'finalization.json')
  let intent = { schema_version: '1', kind: 'kaggle-finalization', inputDigest, inputs,
    evalId: `eval_${randomUUID().replaceAll('-', '')}`, status: 'prepared' }
  let first = true
  try { await writeFile(intentFile, `${JSON.stringify(intent, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    first = false; intent = await readJson(intentFile)
    if (intent.schema_version !== '1' || intent.kind !== 'kaggle-finalization' || intent.inputDigest !== inputDigest
      || identity(intent.inputs) !== inputDigest || !/^eval_[a-f0-9]{32}$/u.test(intent.evalId)
      || !['prepared', 'complete'].includes(intent.status)) throw new Error('output belongs to a different or invalid finalization')
  }
  let inspection
  if (!first) {
    try { inspection = await hitchJson(config, ['eval', 'inspect', intent.evalId, '--json']) }
    catch (error) {
      // Explicit retry only after the public API proves no evaluation was admitted.
      if (!(intent.status === 'prepared' && v['retry-unstarted'] && error.exitCode === 3 && /eval not found/u.test(error.message))) throw error
      first = true
    }
  }
  if (first) {
    const args = ['eval', 'run', '--eval-id', intent.evalId, '--dataset', project.finalizationRef, '--harness', harness,
      '--model', config.hitch.model, '--attempts', '1', '--max-concurrent', '1', '--infrastructure-retries', '0',
      '--timeout', `${config.taskBudgetMs}ms`, '--setup-timeout', `${config.hitch.setupTimeoutMs}ms`, '--output', 'json']
    for (const name of config.hitch.passEnv) args.push('--pass-env', name)
    for (const arg of config.hitch.agentArgs) args.push('--agent-arg', arg)
    // Persisted eval ID makes a lost reply recoverable without another training job.
    await hitchJson(config, args)
    inspection = await hitchJson(config, ['eval', 'inspect', intent.evalId, '--json'])
  }
  if (inspection.schema_version !== '1' || inspection.eval_id !== intent.evalId) throw new Error('finalization evaluation identity mismatch')
  const result = inspection.result
  if (!result) throw new Error(`finalization ${intent.evalId} is still running; rerun this command to inspect it`)
  const rows = result.trials ?? inspection.progress?.trials
  if (rows?.length !== 1 || rows[0].task_id !== 'titanic-finalize' || rows[0].observation_status !== 'valid'
    || rows[0].scores?.total_score !== 1 || !rows[0].run_id) throw new Error('finalization has no valid certified prediction output')
  const { parseRunOutputManifest, parseRunOutputExport } = await import('../../lib/evaluator/run-artifacts.js')
  const runId = rows[0].run_id
  const outputs = parseRunOutputManifest(await hitchJson(config, ['runs', 'artifacts', 'list', runId, '--json']),
    { runId, harnessCommit: v.commit, taskId: 'titanic-finalize', taskDigest: dataset.tasks[0].task_digest, evalId: intent.evalId, attempt: 1 })
  const exportDirectory = join(out, 'artifacts')
  parseRunOutputExport(await hitchJson(config, ['runs', 'artifacts', 'export', runId, '--manifest-digest', outputs.digest,
    '--out', exportDirectory, '--json']), outputs, exportDirectory)
  const candidates = outputs.entries.filter(entry => entry.path === 'output/predictions.csv')
  if (candidates.length !== 1) throw new Error('finalization must export output/predictions.csv')
  const predictionPath = join(exportDirectory, candidates[0].path), bytes = await readFile(predictionPath)
  if (hash(bytes) !== candidates[0].sha256) throw new Error('prediction digest mismatch after export')
  validateSubmission(bytes, competition.submission)
  const submissionFile = join(out, 'submission.csv')
  try { await copyFile(predictionPath, submissionFile, constants.COPYFILE_EXCL) }
  catch (error) { if (error.code !== 'EEXIST' || hash(await readFile(submissionFile)) !== hash(bytes)) throw error }
  intent = { ...intent, status: 'complete', runId, outputManifestDigest: outputs.digest, submissionFile,
    submissionDigest: hash(bytes), competition: competition.submission.competition ?? competition.competition ?? 'titanic',
    synthetic: competition.synthetic === true }
  await atomicJson(intentFile, intent)
  process.stdout.write(`${JSON.stringify(intent, null, 2)}\n`)
}
if (isMain(import.meta.url)) cli(main)
