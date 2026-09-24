// Read-only history admission/recovery canary. Build both repositories first.
// This deliberately retains archived providers; it does not migrate old search identities.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const gear = resolve(process.argv[2] ?? '.'), hitch = resolve(process.argv[3] ?? '../agent-hitch')
const directory = await fs.mkdtemp(join(tmpdir(), 'gear-historical-storage-'))
// Fail closed on every filesystem mutation outside this owned directory, including
// an accidental canonical miss. No original experiment lock or journal is written.
const within = p => typeof p === 'string' && (resolve(p) === directory || resolve(p).startsWith(`${directory}/`))
for (const name of ['mkdir','writeFile','appendFile','rm','unlink','chmod','rmdir']) {
  const original = fs[name].bind(fs)
  fs[name] = (p, ...args) => { assert(within(p), `forbidden historical mutation: ${name} ${p}`); return original(p, ...args) }
}
for (const name of ['rename','copyFile','link','cp']) {
  const original = fs[name].bind(fs)
  fs[name] = (from, to, ...args) => { assert(within(to) && (name !== 'rename' || within(from)), `forbidden historical mutation: ${name}`); return original(from, to, ...args) }
}
const originalOpen = fs.open.bind(fs)
fs.open = (p, flags, ...args) => { if (flags !== 'r') assert(within(p), `forbidden historical write open: ${p}`); return originalOpen(p, flags, ...args) }
syncBuiltinESMExports()
const { RefineStateStore } = await import('../lib/state/store.js')
const { SearchStore, SearchBudgetExceeded } = await import('../lib/search/store.js')
const { recoverExternal, SearchOperationPending } = await import('../lib/search/recovery.js')
const { HitchCliEvaluator } = await import('../lib/evaluator/hitch-cli.js')
const { describeDataset, projectDataset } = await import('../lib/search/dataset-projection.js')
const { digestDatasetRef } = await import('../lib/state/dataset.js')
const { digestJson } = await import('../lib/state/digest.js')
const { inspectEval } = await import(pathToFileURL(join(hitch, 'dist/src/evals/records.js')))
const tracked = new Map(), read = async p => { const bytes = await fs.readFile(p); tracked.set(p, createHash('sha256').update(bytes).digest('hex')); return JSON.parse(bytes) }
const report = { protocol: 'gear-historical-storage-canary@1', directory, paidModelCalls: 0, forbiddenSubmissionAttempts: 0,
  preservedProviderPolicy: 'original executable bytes and --version; no identity translation', rounds: [], projections: [], recoveries: [] }
const signal = new AbortController().signal, deadline = new AbortController(); deadline.abort(new SearchBudgetExceeded('time'))
const deny = () => { report.forbiddenSubmissionAttempts++; throw Error('new evaluation is forbidden') }
const configs = new Map(), evals = new Map(), datasetDigests = new Map()
async function recover(name, round, request, evidence) {
  if (!/^eval_[a-f0-9]{32}$/.test(evidence.evalId) || evals.has(evidence.evalId)) return
  if (evidence.provider === 'hitch-unified-cache-v1') {
    const cache = await read(join(gear,'.evolve-lab',name,'cache/commits',`${evidence.actualCommit}.json`))
    assert.equal(cache.evidenceHash,evidence.metadata.sourceEvidenceHash)
    assert.equal(`sha256:${createHash('sha256').update(JSON.stringify(cache.evidence)).digest('hex')}`,cache.evidenceHash)
    assert.deepEqual(cache.evidence.trials,evidence.trials)
    evidence = cache.evidence
  }
  let config = configs.get(name)
  if (!config) { config = await read(join(gear, '.evolve-lab', name, 'config.json')); configs.set(name, config) }
  const target = join(directory, 'hitch', 'evals', evidence.evalId); await fs.mkdir(target, { recursive: true })
  const source = join(config.hitch.root, 'evals', evidence.evalId)
  for (const file of ['request.json','plan.json','result.json','resolution.json','execution-plan.json','control.json','progress.json','runtime.ref.json']) {
    try { await read(join(source,file)); await fs.copyFile(join(source,file),join(target,file)) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  const evaluator = new HitchCliEvaluator({ ...config.hitch, repositoryPath: config.dshRepository })
  const originalRun = evaluator.run.bind(evaluator)
  evaluator.reserve = evaluator.evaluate = evaluator.recoverReservation = evaluator.cancelReservation = deny
  evaluator.run = async (args, ...rest) => {
    if (JSON.stringify(args) === '["--version"]') return originalRun(args, ...rest)
    assert.deepEqual(args, ['--root', config.hitch.root, 'eval', 'inspect', evidence.evalId, '--json'])
    return { stdout: JSON.stringify(await inspectEval(evidence.evalId, { root: join(directory,'hitch') })), stderr: '', exitCode: 0 }
  }
  const reservation = { provider: 'hitch-cli', evalId: evidence.evalId }
  const store = new SearchStore(join(directory, 'recovery', evidence.evalId))
  const runRecovery = () => recoverExternal({ store, roundId: 'history', operation: { kind: 'evaluation', operationKey: digestJson(reservation) },
    signal: deadline.signal, inspectionSignal: signal, previouslyReserved: true, run: deny, failed: deny,
    inspect: async s => { const v = await evaluator.inspectResult(round, request, reservation, s); return v.status === 'complete' ? { status: 'complete', result: v.evidence } : v } })
  const recovered = (await runRecovery()).value
  for (const key of ['provider','evalId','dataset','requestedCommit','actualCommit','conditionId','effectiveConfigDigest','invocationFingerprint','revisionIdentity','completeness','primaryReward']) assert.deepEqual(recovered[key], evidence[key], `${name}: ${key}`)
  assert.deepEqual(recovered.trials.map(({originalResult,...trial})=>trial), evidence.trials.map(({originalResult,...trial})=>trial), `${name}: trials changed`)
  if (!datasetDigests.has(request.dataset)) datasetDigests.set(request.dataset,await digestDatasetRef(request.dataset))
  assert.equal(datasetDigests.get(request.dataset), request.condition.dataset.digest)
  assert.deepEqual((await runRecovery()).value, recovered)
  // Existing reservation without a durable result remains unknown after reopening.
  await fs.rename(join(target,'result.json'), join(target,'result.saved.json'))
  await assert.rejects(runRecovery, SearchOperationPending)
  const pending = await new SearchStore(store.root).read('rounds/history/pending-operation')
  assert.equal(pending.state, 'unknown')
  await fs.rename(join(target,'result.saved.json'), join(target,'result.json'))
  assert.deepEqual((await runRecovery()).value, recovered)
  const row = { name, evalId: evidence.evalId, dataset: request.dataset, conditionId: evidence.conditionId, trials: recovered.trials.length, invalidTrials: recovered.invalidTrials.length,
    primaryReward: recovered.primaryReward, exactIdentityAndTrials: true, repeatedRecovery: true, unknownReservationPreserved: true }
  evals.set(evidence.evalId,row); report.recoveries.push(row)
  console.error(`Recovered ${name}: ${evidence.evalId}`)
}
try {
  for (const [name,id] of [['marketing-unified-20260911','cf603144-c511-4a37-94aa-4986d7831616'],['marketing-staged-20260912','6e7c54fd-d2f0-428d-bb64-f2730278fa10']]) {
    const root = join(gear,'.evolve-lab',name,'state/evolutions',id), isolated = new RefineStateStore(join(directory,name))
    const spec = await read(join(root,'spec.json')), roundFiles = (await fs.readdir(join(root,'rounds'))).filter(n=>n.endsWith('.json')).sort()
    for (const file of roundFiles) {
      const expected = await read(join(root,'rounds',file)), value = await new RefineStateStore(root).readRound(expected.roundId)
      assert.deepEqual(value,expected); await isolated.writeRound(value); assert.deepEqual(await new RefineStateStore(isolated.root).readRound(value.roundId),value)
      report.rounds.push({ name, roundId:value.roundId, status:value.status, digest:digestJson(value) })
      if (name.includes('unified') && value.evaluation?.seedCandidate) await recover(name,value,{ phase:'seed-candidate',dataset:value.plan.seed.dataset.ref,harnessRef:value.evaluation.seedCandidate.requestedCommit,condition:value.plan.seed },value.evaluation.seedCandidate)
    }
    if (name.includes('staged')) {
      const search = new SearchStore(join(root,'search')), isolatedSearch = new SearchStore(join(directory,name,'search'))
      const description = await describeDataset(spec,'seed',gear), seen = new Set()
      for (const file of (await fs.readdir(join(search.root,'evaluator-operations'))).sort()) {
        const operation = await read(join(search.root,'evaluator-operations',file)); if (!operation.sourceDigest) continue
        await read(join(search.root,'objects',`${operation.sourceDigest.slice(7)}.json`))
        const source = await search.object(operation.sourceDigest); await isolatedSearch.put(source)
        assert.deepEqual(await new SearchStore(isolatedSearch.root).object(source.digest), source)
        const batch = source.batch, ref = batch.request.dataset
        if (!seen.has(ref)) {
          const actual = await projectDataset(description,batch.cells.map(c=>c.taskId),search.root,{ lock:{assertHeld:async p=>assert.equal(p,root)},signal })
          assert.deepEqual(actual,batch.request.condition.dataset); seen.add(ref); report.projections.push(actual)
        }
        await recover(name,batch.round,batch.request,source.evidence)
      }
    }
  }
  for (const name of ['marketing-luna-max-20260912','marketing-champion-luna-max-20260914']) {
    const root = join(gear,'.evolve-lab',name)
    const request = (await read(join(root,'request.json'))).request, round = await read(join(root,'evaluation-context.json'))
    const evidence = await read(join(root,name.includes('champion')?'repaired-evidence.json':'evidence.json'))
    await recover(name,round,request,evidence)
  }
  for (const [file,hash] of tracked) assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash,`history changed: ${file}`)
  report.originalFilesUnchanged = tracked.size
  await fs.writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({ directory, rounds:report.rounds.length, projections:report.projections.length,recoveries:report.recoveries.length,originalFilesUnchanged:tracked.size }))
} catch(error) { await fs.writeFile(join(directory,'failure.json'),JSON.stringify({...report,error:String(error)},null,2)); throw error }
