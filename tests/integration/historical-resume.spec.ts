import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import type { RunJournal } from '../../src/domain/run.js'

// A real, independently built old package is intentional: rebuilding an old
// phase dictionary inside today's worker would miss source/bootstrap drift.
const baselines = [
  { label: 'pre-workflow', path: process.env.GEAR_RECOVERY_BASELINE },
  { label: 'pre-layout', path: process.env.GEAR_RECOVERY_LAYOUT_BASELINE },
].filter((baseline) => baseline.path)
const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface ExternalCall {
  action: string
  operationId: string
  kind: string
  candidateId: string
  partition: string
  slots: Array<{ taskId: string; repetition: number }>
}

async function sourceDigests(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await walk(join(path, entry.name), relative + '/')
      else files[relative] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')
    }
  }
  await walk(root, '')
  return files
}

function outcome(journal: RunJournal) {
  const operationIds = new Map(journal.operations.map((entry, index) =>
    [entry.request.operationId, `operation-${index}`]))
  const semantic = {
    state: journal.state, candidates: journal.candidates,
    seedEvidence: journal.seedEvidence, heldOutEvidence: journal.heldOutEvidence,
    championId: journal.championId, nomineeId: journal.nomineeId, gate: journal.gate,
    physicalAttempts: journal.physicalAttempts,
    // Run/operation IDs and admission timestamps differ between independent
    // runs. Decision policies, scopes, ranking and every observed cell must not.
    decisions: journal.decisions.map(({ decision }) => decision),
    metering: journal.operations.reduce((usage, operation) => ({
      model_requests: usage.model_requests + (operation.receipt?.usage.model_requests ?? 0),
      tokens: usage.tokens + (operation.receipt?.usage.tokens ?? 0),
    }), { model_requests: 0, tokens: 0 }),
  }
  // Native workflow journals also retain the concrete operation IDs inside
  // their replay history. Compare their positions across independent run IDs.
  return JSON.parse(JSON.stringify(semantic, (_key, value: unknown) =>
    typeof value === 'string' && operationIds.has(value) ? operationIds.get(value) : value)) as typeof semantic
}

const interruptions = [
  ['gepa', 'generate_candidate'], ['gepa', 'evaluate_seed'],
  ['random-search', 'generate_candidate'], ['random-search', 'evaluate_seed'],
] as const
it.skipIf(!baselines.length).each(
  (baselines.length ? baselines : [{ label: 'unconfigured', path: undefined }]).flatMap((baseline) =>
    interruptions.map(([algorithm, interruptedKind]) => ({ ...baseline, algorithm, interruptedKind }))),
)(
  'resumes $label $algorithm after lost $interruptedKind completion through the current CLI',
  async ({ path: baseline, algorithm, interruptedKind }) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-historical-resume-')); roots.push(root)
    const profiles = join(root, 'profiles'); await mkdir(profiles)
    const python = resolvePythonExecutable(true)
    const env = { ...process.env, GEAR_PYTHON: python, GEAR_PROFILE_ROOT: profiles,
      GEAR_HOME: join(root, 'managed'), PYTHONPATH: '', PYTHONDONTWRITEBYTECODE: '1' }
    const oldCli = join(resolve(baseline!), 'lib/cli.js'), currentCli = resolve('lib/cli.js')
    const command = async (cli: string, project: string, args: string[]) => execute(process.execPath,
      [cli, '--project', project, '--json', ...args], { env, cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    const profile = { command: [process.execPath, resolve('tests/fixtures/historical-search-provider.mjs')],
      workingDirectory: root, passEnv: [], timeoutMs: 30_000, configuration: {} }
    for (const role of ['target', 'meta'])
      await writeFile(join(profiles, `historical-${role}.json`), JSON.stringify(profile))
    const config = {
      version: 1, benchmark: './benchmark.yaml', target: { adapter: 'pi', path: './target', profile: 'historical-target' },
      meta: { profile: 'historical-meta' }, algorithm, objective: { metric: 'pass_rate' },
      validation: { mode: 'holdout' }, budget: { rounds: 2, max_evaluations: 100, max_candidates: 2, repetitions: 1 },
      generation: { max_model_requests: 4, max_tokens: 128, per_operation: { max_model_requests: 1, max_tokens: 32 } },
      evaluation: { repair: { max_retries: 0, max_projections: 0, backoff_ms: [0] } },
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { sandbox: { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION } } : {}),
    }
    const project = join(root, 'interrupted'), reference = join(root, 'uninterrupted')
    await command(oldCli, root, ['init', project, '--target', 'pi', '--template', 'text',
      '--target-profile', 'historical-target', '--meta-profile', 'historical-meta'])
    await writeFile(join(project, 'gear.yaml'), JSON.stringify(config))
    await writeFile(join(project, 'tasks.csv'), 'id,instruction,expected,family,split\n' + [
      ...Array.from({ length: 12 }, (_, i) => `seed-${i},Return the requested value.,42,family-${i % 3},seed`),
      'private-1,Private held-out observation.,43,private,held_out',
      'private-2,Another private held-out observation.,44,private,held_out',
    ].join('\n') + '\n')
    await cp(project, reference, { recursive: true })
    await writeFile(join(project, 'interrupt.json'), JSON.stringify({ kind: interruptedKind, candidatePrefix: 'r1-' }))

    await expect(command(oldCli, project, ['refine'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Historical submission reply lost'),
    })
    const [runId] = await readdir(join(project, '.gear/runs'))
    expect(runId).toMatch(/^run_[a-f0-9]{32}$/)
    const runRoot = join(project, '.gear/runs', runId!)
    const readJournal = async () => JSON.parse(await readFile(join(runRoot, 'journal.json'), 'utf8')) as RunJournal
    const calls = async () => (await readFile(join(runRoot, 'external-fixture/calls.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as ExternalCall)
    const before = await readJournal(), beforeCalls = await calls()
    const sourceBefore = await sourceDigests(join(runRoot, 'algorithm'))
    expect(before.status).toBe('needs_recovery')
    const phase = interruptedKind === 'generate_candidate' ? 'generated' : 'rank'
    if (before.state.data.workflow === 1) {
      // The last pre-layout release already used native GEPA workflows; its
      // frozen worker must keep replaying that workflow after files move.
      expect(algorithm).toBe('gepa')
      expect(before.state.data.policy_state).toMatchObject({ phase })
    } else {
      expect(before.state.data.phase).toBe(phase)
    }
    const lost = before.operations.find((operation) => operation.status === 'submitted')!
    expect(lost.request.operation.kind).toBe(interruptedKind)
    expect(before.physicalAttempts).toBe(24)
    expect(before.completed.filter((operation) => operation.kind === 'diagnose_seed')).toHaveLength(2)
    expect(sourceBefore['gear/algorithms/contracts.py']).toBeTruthy()
    expect(sourceBefore['gear/algorithms/operators.py']).toBeTruthy()
    const oldExperience = before.operations.map((entry) => entry.request.experience)
      .find((experience) => experience && experience.available_records > 0)!
    expect(oldExperience.available_records).toBe(1)
    const queryArgs = ['experience', 'query', runId!, '--snapshot', oldExperience.snapshot_digest]
    const oldQuery = JSON.parse((await command(oldCli, project, queryArgs)).stdout)
    expect(oldQuery.items).toHaveLength(1)
    const oldRef = oldQuery.items[0].card.ref as string
    const readArgs = ['experience', 'read', runId!, oldRef, '--snapshot', oldExperience.snapshot_digest, '--view', 'task-results']
    const oldRead = JSON.parse((await command(oldCli, project, readArgs)).stdout)
    expect(oldRead.items.length).toBeGreaterThan(0)

    // The mutable project and current algorithms are not allowed to replace a
    // committed old policy or its admitted configuration during resume.
    await rm(join(project, 'interrupt.json'))
    await writeFile(join(project, 'gear.yaml'), JSON.stringify({ ...config, algorithm: 'missing:MustNotLoad' }))
    const resumed = JSON.parse((await command(currentCli, project, ['resume', runId!])).stdout)
    const after = await readJournal(), afterCalls = await calls()
    expect(after.status).toBe('completed')
    expect(after.spec).toEqual(before.spec)
    expect(after.specDigest).toBe(before.specDigest)
    expect(after.decisions.slice(0, before.decisions.length)).toEqual(before.decisions)
    expect(await sourceDigests(join(runRoot, 'algorithm'))).toEqual(sourceBefore)
    for (const operation of before.operations) {
      const recovered = after.operations.find((entry) => entry.request.operationId === operation.request.operationId)!
      expect(recovered.request).toEqual(operation.request)
      if (operation.receipt) expect(recovered.receipt).toEqual(operation.receipt)
    }
    expect(after.seedEvidence.slice(0, before.seedEvidence.length)).toEqual(before.seedEvidence)
    const newCalls = afterCalls.slice(beforeCalls.length)
    expect(newCalls).toContainEqual(expect.objectContaining({ action: 'inspect', operationId: lost.request.operationId }))
    expect(newCalls.filter((call) => call.action === 'submit').map((call) => call.operationId))
      .not.toContain(lost.request.operationId)
    const submits = afterCalls.filter((call) => call.action === 'submit')
    expect(new Set(submits.map((call) => call.operationId)).size).toBe(submits.length)
    const physicalSlots = submits.flatMap((call) => call.slots.map((slot) =>
      JSON.stringify([call.partition, call.candidateId, slot.taskId, slot.repetition])))
    expect(new Set(physicalSlots).size).toBe(physicalSlots.length)
    expect(physicalSlots).toHaveLength(after.physicalAttempts)
    expect(after.candidates).toHaveLength(3)
    expect(after.heldOutEvidence).toHaveLength(4)
    expect(after.physicalAttempts).toBe(40)
    expect(outcome(after).metering).toEqual({ model_requests: 4, tokens: 32 })
    expect(resumed.generation_budget.metrics.model_requests.remaining).toBe(0)
    expect(resumed.generation_budget.metrics.tokens.remaining).toBe(96)
    expect(resumed.generation_budget.violations).toEqual([])

    const uninterruptedReport = JSON.parse((await command(oldCli, reference, ['refine'])).stdout)
    const uninterrupted = JSON.parse(await readFile(join(reference, '.gear/runs', uninterruptedReport.run_id, 'journal.json'), 'utf8')) as RunJournal
    expect(outcome(after)).toEqual(outcome(uninterrupted))
    expect(resumed.generation_budget).toEqual(uninterruptedReport.generation_budget)
    expect(resumed.coverage).toEqual(uninterruptedReport.coverage)
    expect(resumed.gate).toEqual(uninterruptedReport.gate)
    expect(JSON.parse((await command(currentCli, project, queryArgs)).stdout)).toEqual(oldQuery)
    expect(JSON.parse((await command(currentCli, project, readArgs)).stdout)).toEqual(oldRead)
    const archived = JSON.parse((await command(currentCli, project, ['archive', runId!])).stdout)
    expect(archived.projection.status).toBe('available')
    expect(archived.objects.filter((object: { kind: string }) => object.kind === 'evidence').length).toBeGreaterThan(0)
    const completedDigest = after.digest, count = afterCalls.length
    await command(currentCli, project, ['resume', runId!])
    expect((await readJournal()).digest).toBe(completedDigest)
    expect(await calls()).toHaveLength(count)
  }, 90_000,
)
