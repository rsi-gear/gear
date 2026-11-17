import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { HitchOperatorArtifacts } from '../../src/adapters/hitch/operator-artifacts.js'
import type { OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import type { OperatorArtifact } from '../../src/domain/operator-run.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { GearError } from '../../src/domain/errors.js'

const signal = () => new AbortController().signal
async function fixture() {
  const manifest = JSON.parse(
    await readFile(new URL('../../test-contracts/run-output-artifacts-v1.json', import.meta.url), 'utf8'),
  )
  const request = { slots: [{ taskId: manifest.task_id, repetition: 0 }] } as OperationRequest
  const receipt = {
    provenance: {
      evaluations: [
        {
          eval_id: manifest.eval_id,
          trials: [
            {
              task_id: manifest.task_id,
              run_id: manifest.run_id,
              attempt: 1,
              reward: 1,
              invalid_reason: 'PRIVATE_SCORING_CANARY',
            },
          ],
        },
      ],
      execution_artifacts: [{ eval_id: manifest.eval_id, repetition: 0 }],
      verifier_sources: [{ data: 'PRIVATE_VERIFIER_CANARY' }],
    },
  } as unknown as OperationReceipt
  const revision = canonicalDigest('target-runtime')
  const observed = {
    schema_version: '1',
    record_status: 'valid',
    trajectory_status: 'valid',
    verifier_status: 'missing',
    issues: ['PRIVATE_ISSUE_CANARY'],
    record: {
      run_id: manifest.run_id,
      status: 'succeeded',
      context: { kind: 'benchmark_task', task_id: manifest.task_id },
      parent: { eval_id: manifest.eval_id, attempt: 1 },
      harness: { revision_identity: revision },
      observation: { status: 'invalid', invalid_reason: 'PRIVATE_OBSERVATION_CANARY' },
    },
  }
  const calls: string[][] = []
  let unavailable = false,
    failRead = false,
    excerpt = false
  const reader = new HitchOperatorArtifacts(
    async (args) => {
      calls.push(args)
      if (args[0] === 'runs' && args[1] === 'inspect') return observed
      if (args[0] === 'runs' && args[1] === 'artifacts') {
        if (failRead) throw new GearError('hitch-call-failed', 'transport failed')
        if (unavailable) throw new GearError('hitch-output-unavailable', 'No declared files')
        return manifest
      }
      if (args[0] !== 'trajectory') throw new Error('Unexpected side effect')
      const types = args[args.indexOf('--types') + 1]!.split(',')
      expect(types).not.toContain('verifier/result')
      return {
        schema_version: '1',
        kind: 'trajectory-events-page',
        run_id: manifest.run_id,
        canonical_sha256: canonicalDigest('messages'),
        filter: { types: [...new Set(types)].sort() },
        eof: true,
        total_matches: 1,
        private_extra: 'PRIVATE_PAGE_CANARY',
        events: [
          {
            seq: 0,
            type: 'assistant/message',
            private_extra: 'PRIVATE_EVENT_CANARY',
            ...(excerpt
              ? { event_excerpt: { preview: 'partial', private_ref: 'PRIVATE_EXCERPT_CANARY' } }
              : {
                  data: {
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'answer' }],
                      source: { diagnostics: 'PRIVATE_SOURCE_CANARY' },
                    },
                    usage: { verifier_tokens: 100, private: 'PRIVATE_USAGE_CANARY' },
                  },
                }),
          },
        ],
      }
    },
    '/unused/operator-cache',
    revision,
  )
  return {
    reader,
    request,
    receipt,
    observed,
    manifest,
    calls,
    options: (options: { unavailable?: boolean; failRead?: boolean; excerpt?: boolean }) => {
      unavailable = options.unavailable ?? false
      failRead = options.failRead ?? false
      excerpt = options.excerpt ?? false
    },
  }
}
function artifact(
  value: Awaited<ReturnType<HitchOperatorArtifacts['capture']>>[number]['output'],
): OperatorArtifact {
  return {
    ref: {
      run_id: 'run',
      kind: 'task_output',
      digest: canonicalDigest(value.value),
      visibility: 'optimization',
    },
    value: value.value,
    sources: [],
    ...(value.external ? { external: value.external } : {}),
  }
}

it('projects target status and messages independently of scores, verifier failures and private extensions', async () => {
  const f = await fixture()
  const first = await f.reader.capture(f.request, f.receipt, signal())
  f.observed.record.observation.status = 'valid'
  f.observed.verifier_status = 'valid'
  expect(await f.reader.capture(f.request, f.receipt, signal())).toEqual(first)
  expect(first[0]!.status).toBe('succeeded')
  expect(first[0]!.output.value).toMatchObject({ available: true, kind: 'declared-files' })
  const content = await f.reader.read(artifact(first[0]!.trajectory!), null, signal())
  expect(JSON.parse(content.toString())).toMatchObject({
    content_complete: true,
    events: [{ content: [{ type: 'text', text: 'answer' }] }],
  })
  expect(JSON.stringify(first) + content).not.toContain('PRIVATE_')
  await expect(
    f.reader.read(artifact(first[0]!.trajectory!), '../verifier/result.json', signal()),
  ).rejects.toMatchObject({ code: 'material-path-invalid' })
})

it('uses the target transcript when declared files are unavailable, without treating excerpts as complete', async () => {
  const f = await fixture()
  f.options({ unavailable: true, excerpt: true })
  const captured = await f.reader.capture(f.request, f.receipt, signal())
  expect(captured[0]!.output.value).toMatchObject({ kind: 'target-transcript' })
  const bytes = await f.reader.read(artifact(captured[0]!.output), null, signal())
  expect(JSON.parse(bytes.toString())).toMatchObject({ content_complete: false, events: [{ omitted: true }] })
  expect(bytes.toString()).not.toContain('PRIVATE_')
})

it('preserves read uncertainty and rejects an output or target identity mismatch', async () => {
  const f = await fixture()
  f.options({ failRead: true })
  await expect(f.reader.capture(f.request, f.receipt, signal())).rejects.toMatchObject({
    code: 'hitch-call-failed',
  })
  f.options({})
  f.manifest.task_id = 'different-task'
  await expect(f.reader.capture(f.request, f.receipt, signal())).rejects.toMatchObject({
    code: 'target-artifact-invalid',
  })
  f.observed.record.parent.eval_id = 'different-evaluation'
  await expect(f.reader.capture(f.request, f.receipt, signal())).rejects.toMatchObject({
    code: 'target-artifact-invalid',
  })
})
