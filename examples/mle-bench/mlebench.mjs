#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { cli, command, isMain } from './lib/common.mjs'
import { inspectMlebench, treeManifest, fileHash } from './lib/mlebench.mjs'
import { assert, seal, sha, verify } from './lib/contracts.mjs'
import { Store, json, atomicJson, optionalJson } from './lib/store.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { validateTabularSubmission } from './lib/submission.mjs'
const here = dirname(fileURLToPath(import.meta.url))

export async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(['repository', 'data-root', 'competition', 'python', 'project', 'sequence', 'out', 'submission'].map(k => [k, { type: 'string' }])),
    fixture: { type: 'boolean' }, 'record-checksums': { type: 'boolean' },
  } })
  const action = positionals[0]
  if (action === 'export') {
    assert(v.project && v.sequence && v.out, '--project, --sequence, --out required')
    const project = await json(join(resolve(v.project), 'project.json')), store = new Store(join(resolve(v.project), 'research'))
    const state = await store.load('sequences', v.sequence.replace(/^sha256:/, ''))
    assert(state?.receipt && state.receipt.delivery.status === 'completed' && project.task.benchmark, 'valid MLE-bench final selected solution required')
    verify(state.plan); verify(state.receipt)
    assert(state.plan.task.digest === project.task.digest && state.receipt.planDigest === state.plan.digest
      && state.receipt.selections.at(-1).incumbentSolutionDigest === state.receipt.delivery.solutionDigest, 'export must use this task and its actual final selected solution')
    const backend = new HitchBackend(store, project.backend); await backend.admit(state.plan); await backend.verifyReceipt(state.receipt)
    const delivered = state.receipt.delivery, op = await store.load('executions', delivered.requestDigest.slice(7))
    const bytes = await readFile(join(op.destination, 'output/predictions.csv'))
    assert(sha(bytes) === delivered.predictionsDigest, 'sealed final selected solution predictions changed')
    validateTabularSubmission(bytes, project.task)
    const out = resolve(v.out); await mkdir(out, { recursive: true })
    try { await writeFile(join(out, 'submission.csv'), bytes, { flag: 'wx' }) }
    catch (e) { if (e.code !== 'EEXIST' || sha(await readFile(join(out, 'submission.csv'))) !== sha(bytes)) throw e }
    const report = seal({ protocol: 'mlebench-sealed-submission@1', competition_id: project.task.benchmark.competitionId,
      submission_path: join(out, 'submission.csv'), submissionDigest: sha(bytes), sequenceReceiptDigest: state.receipt.digest,
      runId: delivered.runId, solutionDigest: delivered.solutionDigest, rawScore: delivered.score, metric: delivered.metric })
    const existing = await optionalJson(join(out, 'receipt.json'))
    if (existing) { verify(existing); assert(existing.digest === report.digest, 'export directory belongs to another sequence') }
    await atomicJson(join(out, 'receipt.json'), report)
    await writeFile(join(out, 'submissions.jsonl'), JSON.stringify({ competition_id: report.competition_id, submission_path: report.submission_path }) + '\n')
    console.log(JSON.stringify(report)); return
  }
  assert(v.repository && v['data-root'] && v.competition, '--repository, --data-root, --competition required')
  const options = { repository: resolve(v.repository), dataRoot: resolve(v['data-root']), competition: v.competition, fixture: v.fixture ?? false }
  if (action === 'inspect') { console.log(JSON.stringify((await inspectMlebench(options)).descriptor, null, 2)); return }
  assert(['prepare-local', 'grade'].includes(action), 'action must be inspect, prepare-local, grade or export')
  if (action === 'grade') { assert(v.submission, '--submission required'); await inspectMlebench(options) }
  const output = await command(v.python ?? 'python3', [join(here, 'mlebench-native.py'), action === 'grade' ? 'grade' : 'prepare',
    '--data-root', options.dataRoot, '--competition', options.competition, ...(v.submission ? ['--submission', resolve(v.submission)] : [])],
    { env: { ...process.env, PYTHONPATH: options.repository } })
  if (action === 'prepare-local' && v['record-checksums']) {
    assert(v.competition === 'titanic', 'do not overwrite official benchmark checksums')
    const body = {}
    for (const role of ['public', 'private']) {
      const directory = join(options.dataRoot, v.competition, 'prepared', role)
      body[role] = Object.fromEntries(await Promise.all((await treeManifest(directory)).filter(f => !f.path.includes('/') && f.path.endsWith('.csv'))
        .map(async f => [f.path, await fileHash(join(directory, f.path), 'md5')])))
    }
    await writeFile(join(options.repository, 'mlebench/competitions', v.competition, 'checksums.yaml'), yaml.dump(body))
  }
  console.log(output)
}
if (isMain(import.meta.url)) cli(main)
