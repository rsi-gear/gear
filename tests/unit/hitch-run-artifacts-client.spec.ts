import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import { parseRunOutputManifest, type RunOutputManifest } from '../../src/evaluator/run-artifacts.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const runId = `run_${'a'.repeat(32)}`, evalId = `eval_${'b'.repeat(32)}`, commit = 'c'.repeat(40)
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
function manifest(): RunOutputManifest {
  const body = { schema_version: '1' as const, kind: 'run-output-artifacts' as const, run_id: runId, eval_id: evalId,
    task_id: 'titanic-finalize', attempt: 1, harness_commit: commit, task_digest: sha('task'),
    entries: [{ name: 'output/predictions.csv', path: 'output/predictions.csv', media_type: 'text/csv', bytes: 1, sha256: sha('x') }] }
  return { ...body, digest: digestJson(body) }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-artifact-client-'))); roots.push(root)
  const executable = join(root, 'hitch.mjs'), wire = join(root, 'wire.json'), log = join(root, 'calls.jsonl')
  await writeFile(wire, JSON.stringify(manifest()))
  await writeFile(executable, `#!/usr/bin/env node
import {readFileSync, appendFileSync, mkdirSync, realpathSync} from 'node:fs';
import {dirname,basename,join} from 'node:path';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='capabilities'){ console.log(JSON.stringify({schema_version:'1',trajectory_analysis:'1',trajectory_events_page:'1',run_output_artifacts:'1'})); }
else {if(args[0]!=='--root'||args[1]!==${JSON.stringify(root)}||args[2]!=='runs'||args[3]!=='artifacts') process.exit(9);
const manifest=JSON.parse(readFileSync(${JSON.stringify(wire)},'utf8'));
if(args[4]==='list') console.log(JSON.stringify(manifest));
else {if(args[5]!==manifest.run_id||args[args.indexOf('--manifest-digest')+1]!==manifest.digest) process.exit(8);
const requested=args[args.indexOf('--out')+1], destination=join(realpathSync(dirname(requested)),basename(requested));mkdirSync(destination,{recursive:true});
console.log(JSON.stringify({schema_version:'1',kind:'run-output-artifacts-export',run_id:manifest.run_id,manifest_digest:manifest.digest,destination}));}}
`, { mode: 0o755 })
  const evaluator = new HitchCliEvaluator({ executable, root, repositoryPath: root, harnessId: 'deepseek', model: 'fixture', attempts: 1,
    maxConcurrent: 1, setupTimeoutMs: 1000, terminationGraceMs: 10, maxOutputBytes: 1024 * 1024, maxTrajectoryOutputBytes: 1024 * 1024,
    sampling: {}, agentArgs: [], passEnv: [] })
  return { root, wire, log, evaluator }
}

describe('Hitch public output client', () => {
  it('uses public root-bound list/export and accepts the canonical destination across path aliases', async () => {
    const f = await fixture(), signal = new AbortController().signal
    const outputs = await f.evaluator.listRunOutputArtifacts({ runId, harnessCommit: commit, evalId, attempt: 1 }, signal)
    await mkdir(join(f.root, 'real')); await symlink(join(f.root, 'real'), join(f.root, 'alias'))
    const exported = await f.evaluator.exportRunOutputArtifacts(outputs, join(f.root, 'alias', 'outputs'), signal)
    expect(exported.destination).toBe(join(f.root, 'real', 'outputs'))
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args.includes('list'))).toHaveLength(2)
    expect(calls.at(-1)).toEqual(['--root', f.root, 'runs', 'artifacts', 'export', runId, '--manifest-digest', outputs.digest,
      '--out', exported.destination, '--json'])
  })
  it('rejects changed provenance or saved manifests before invoking export', async () => {
    const f = await fixture(), signal = new AbortController().signal, outputs = manifest()
    await expect(f.evaluator.listRunOutputArtifacts({ runId, harnessCommit: 'd'.repeat(40) }, signal)).rejects.toThrow('provenance')
    const { digest: _, ...body } = outputs, updated = { ...body, entries: [] }
    await writeFile(f.wire, JSON.stringify({ ...updated, digest: digestJson(updated) }))
    await expect(f.evaluator.exportRunOutputArtifacts(outputs, join(f.root, 'out'), signal)).rejects.toThrow('manifest changed')
    expect(await readFile(f.log, 'utf8')).not.toContain('"export"')
  })
  it('rejects daemon use and malformed bounded wire entries', async () => {
    const f = await fixture(); f.evaluator.options.controlPlane = { mode: 'daemon', requireModelCapture: false }
    await expect(f.evaluator.listRunOutputArtifacts({ runId }, new AbortController().signal)).rejects.toThrow('direct mode')
    for (const change of [{ path: '../escape' }, { path: 'x:stream', name: 'x:stream' }, { bytes: 16 * 1024 * 1024 + 1 }]) {
      const { digest: _, ...body } = manifest(), value = { ...body, entries: [{ ...body.entries[0]!, ...change }] }
      expect(() => parseRunOutputManifest({ ...value, digest: digestJson(value) }, { runId })).toThrow()
    }
    expect(() => parseRunOutputManifest(manifest(), { runId, evalId: `eval_${'f'.repeat(32)}` })).toThrow('provenance')
  })
})
