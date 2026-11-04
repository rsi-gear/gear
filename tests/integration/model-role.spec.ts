import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelOperationProvider, type ModelProfile } from '../../src/adapters/model/provider.js'
import { configuredProvider } from '../../src/application/profiles.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { validateProfile } from '../../src/application/profile-store.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { ProjectRuntimeContext } from '../../src/application/project-service.js'
import type { OperationRequest } from '../../src/ports/operations.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(mode: 'valid' | 'invalid' | 'disconnect' = 'valid') {
  const root = await mkdtemp(join(tmpdir(), 'gear-model-role-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const calls: unknown[] = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    calls.push({ body: JSON.parse(text), authorization: request.headers.authorization })
    if (mode === 'disconnect') {
      request.socket.destroy()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                declined: false,
                data: mode === 'invalid' ? { unexpected: 'object' } : 'Repair output formatting.',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  )
  const port = (server.address() as { port: number }).port
  const profile: ModelProfile = {
    kind: 'model',
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: 'fixture',
    apiKeyEnv: 'GEAR_MODEL_FIXTURE_KEY',
    passEnv: ['GEAR_MODEL_FIXTURE_KEY'],
    maxCompletionTokens: 128,
    timeoutMs: 1000,
  }
  process.env.GEAR_MODEL_FIXTURE_KEY = 'fixture-key'
  cleanups.push(async () => {
    delete process.env.GEAR_MODEL_FIXTURE_KEY
  })
  return { root, calls, profile }
}
function request(): OperationRequest {
  return {
    operationId: canonicalDigest('model-role-call'),
    runId: 'run',
    generation: 1,
    operation: {
      kind: 'diagnose_seed',
      candidate_id: 'anchor',
      parent_id: null,
      task_ids: ['seed'],
      scope: 'global',
      rationale: 'analyst',
      payload: {
        gear_role_v1: 'analyst',
        inputs: { score: 0 },
        meta: { prompt: 'Propose a general improvement.', schema: { type: 'string' } },
      },
    },
    partition: 'seed',
    repetitions: 1,
    slots: [],
    evidence: [],
  }
}

it('posts one structured request, validates output locally and reuses the durable receipt', async () => {
  const { root, profile, calls } = await fixture()
  expect(validateProfile(profile)).toEqual(profile)
  const context = {
    directory: join(root, 'model'),
    tasks: [{ id: 'seed', family: 'format', instruction: 'Write JSON.' }],
  }
  const provider = await ModelOperationProvider.connect(profile, context)
  const receipt = await provider.submit(request(), new AbortController().signal)
  expect(receipt.result).toMatchObject({
    status: 'complete',
    data: { declined: false, data: 'Repair output formatting.' },
  })
  expect(receipt.usage).toEqual({ model_requests: 1, input_tokens: 3, output_tokens: 2, tokens: 5 })
  expect(await provider.submit(request(), new AbortController().signal)).toEqual(receipt)
  const restarted = await ModelOperationProvider.connect(profile, context)
  expect(await restarted.inspect(request())).toEqual({ state: 'complete', receipt })
  await expect(
    provider.submit({ ...request(), generationLimits: { tokens: 50 } }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'generation-budget-unsupported' })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    authorization: 'Bearer fixture-key',
    body: { model: 'fixture', stream: false, n: 1 },
  })
  expect(JSON.stringify(calls)).not.toContain('held_out')
})

it('rejects data outside the declared schema while recording the paid request', async () => {
  const { root, profile, calls } = await fixture('invalid')
  const provider = await ModelOperationProvider.connect(profile, {
    directory: join(root, 'model'),
    tasks: [],
  })
  const receipt = await provider.submit(request(), new AbortController().signal)
  expect(receipt.result).toMatchObject({ status: 'failed', data: { error: 'model-output-invalid' } })
  expect(receipt.usage.model_requests).toBe(1)
  expect(calls).toHaveLength(1)
})

it('retains unknown POSTs without resubmission or unconfirmed cancellation', async () => {
  const { root, profile, calls } = await fixture('disconnect')
  const provider = await ModelOperationProvider.connect(profile, {
    directory: join(root, 'model'),
    tasks: [],
  })
  await expect(provider.submit(request(), new AbortController().signal)).rejects.toMatchObject({
    code: 'model-result-unknown',
  })
  expect(await provider.inspect(request())).toEqual({ state: 'unknown' })
  await expect(provider.submit(request(), new AbortController().signal)).rejects.toMatchObject({
    code: 'model-result-unknown',
  })
  await expect((await configuredCancellation(provider.cancellation)).cancel(request())).rejects.toMatchObject(
    { code: 'model-cancellation-unknown' },
  )
  expect(calls).toHaveLength(1)
})

it('routes registered roles by frozen profile, defaults unbound roles and cancels without profile lookup', async () => {
  const { root, profile, calls } = await fixture()
  const profiles = join(root, 'profiles')
  await mkdir(profiles)
  const priorRoot = process.env.GEAR_PROFILE_ROOT
  process.env.GEAR_PROFILE_ROOT = profiles
  cleanups.push(async () => {
    if (priorRoot === undefined) delete process.env.GEAR_PROFILE_ROOT
    else process.env.GEAR_PROFILE_ROOT = priorRoot
  })
  const executable = join(root, 'provider.mjs'),
    cancellations = join(root, 'cancellations.jsonl')
  await writeFile(
    executable,
    `import fs from 'node:fs';let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);const caps={seeds:true,temperature:true,subsets:true,idempotentSubmission:true,inspect:true,cancel:true,physicalAttemptAccounting:true,hardDollarBudget:false,generationBudget:false,evidenceProjection:false};let out;if(v.action==='describe')out={version:1,identity:'sha256:'+'1'.repeat(64),capabilities:caps};else if(v.action==='cancel'){fs.appendFileSync(v.configuration.log,JSON.stringify(v.configuration.name)+'\\n');out={cancelled:true}}else out={result:{operation_id:v.request.operationId,kind:v.request.operation.kind,status:'complete',candidate_id:v.request.operation.candidate_id,data:{declined:false,data:v.configuration.name}},candidate:null,evidence:[],physicalAttempts:0,usage:{},provenance:null};console.log(JSON.stringify(out));`,
  )
  for (const name of ['target', 'default'])
    await writeFile(
      join(profiles, name + '.json'),
      JSON.stringify({
        command: [process.execPath, executable],
        workingDirectory: root,
        passEnv: [],
        configuration: { name, log: cancellations },
        timeoutMs: 1000,
      }),
    )
  await writeFile(join(profiles, 'analyst.json'), JSON.stringify(profile))
  const context = {
    kind: 'refine',
    root,
    stateRoot: join(root, '.gear'),
    runId: 'run',
    config: {
      target: { adapter: 'pi', profile: 'target' },
      meta: { profile: 'default', roles: { analyst: 'analyst', constructor: 'analyst' } },
    },
    benchmark: {
      tasks: [{ id: 'seed', family: 'format', instruction: 'Write JSON.' }],
      splits: { seed: ['seed'] },
    },
  } as unknown as ProjectRuntimeContext
  const provider = await configuredProvider(context)
  const selected = request()
  expect((await provider.submit(selected, new AbortController().signal)).result.data).toEqual({
    declined: false,
    data: 'Repair output formatting.',
  })
  const fallback = request()
  fallback.operationId = canonicalDigest('unbound-role')
  ;(fallback.operation.payload as Record<string, unknown>).gear_role_v1 = 'critic'
  expect((await provider.submit(fallback, new AbortController().signal)).result.data).toEqual({
    declined: false,
    data: 'default',
  })
  const named = request()
  named.operationId = canonicalDigest('constructor-role')
  ;(named.operation.payload as Record<string, unknown>).gear_role_v1 = 'constructor'
  expect((await provider.submit(named, new AbortController().signal)).result.data).toEqual({
    declined: false,
    data: 'Repair output formatting.',
  })
  ;(fallback.operation.payload as Record<string, unknown>).gear_role_v1 = '__proto__'
  expect((await provider.submit(fallback, new AbortController().signal)).result.data).toEqual({
    declined: false,
    data: 'default',
  })
  const unsupported = request()
  unsupported.operation.kind = 'generate_candidate'
  expect(() => provider.validateOperation!(unsupported.operation)).toThrow('read-only role')
  await rm(profiles, { recursive: true })
  await (await configuredCancellation(provider.cancellation!)).cancel(fallback)
  expect(await readFile(cancellations, 'utf8')).toBe('"default"\n')
  expect(calls).toHaveLength(2)
})
