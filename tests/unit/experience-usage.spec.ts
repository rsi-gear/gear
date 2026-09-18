import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchNativeExperienceUsageReader } from '../../src/experience/hitch-native-usage.js'
import {
  enrichSeedExperienceUse,
  extractTrialModificationUse,
  runtimeSkillBody,
  type ExperienceChangedArtifactInput,
  type ExperienceUsageReadResult,
  type ExperienceUsageTrace,
  type ExperienceUsageTraceFile,
} from '../../src/experience/usage.js'
import type { SeedExperienceRecord } from '../../src/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

const SKILL_NAME = 'checked-reads'
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md`
const SKILL_BODY = '# Checked reads\n\nRead exact evidence before acting.'
const SKILL = `---\nname: ${SKILL_NAME}\ndescription: test\n---\n${SKILL_BODY}\n`

function changed(path = SKILL_PATH, content = SKILL): ExperienceChangedArtifactInput {
  return {
    identity: { path, change: 'created', candidateDigest: digest(content) },
    candidateContent: content,
  }
}

function resultEvent(callId: string, content: unknown, isError = false, seq = 2): Record<string, unknown> {
  return {
    type: 'tool/result',
    seq,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
      },
    },
  }
}

function skillOutput(body = SKILL_BODY): string {
  return `<skill_content name="${SKILL_NAME}">\n<skill_resources>\nBase directory: /candidate/harness/${SKILL_PATH}\n</skill_resources>\n\n<skill_instructions>\n${body}\n</skill_instructions>\n</skill_content>`
}

function file(events: Record<string, unknown>[], values: Partial<ExperienceUsageTraceFile> = {}): ExperienceUsageTraceFile {
  return {
    sourcePath: 'trajectory/provider/deepseek-session.jsonl',
    sourceDigest: digest('source'),
    bytes: 100,
    sessionId: 'session-main',
    delegationDepth: 0,
    events: events as never,
    ...values,
  }
}

function trace(
  files: ExperienceUsageTraceFile[],
  coverage: ExperienceUsageTrace['coverage'] = 'listed-files-complete',
  runId = 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
): ExperienceUsageReadResult {
  return {
    available: true,
    trace: {
      schemaVersion: 1,
      kind: 'dsh-native-events',
      runId,
      trajectoryManifestDigest: digest('manifest'),
      listedFiles: files.length,
      mainSessionFiles: 1,
      childSessionFiles: files.length - 1,
      coverage,
      files,
    },
  }
}

describe('seed experience modified-resource use', () => {
  it('matches a successful exact skill body in a child session and keeps its native source identity', () => {
    const callId = 'call-child'
    const child = file([
      { type: 'tool/call', seq: 10, data: { callId, name: 'skill', arguments: JSON.stringify({ name: SKILL_NAME }) } },
      resultEvent(callId, [{ type: 'text', text: skillOutput() }], false, 11),
    ], {
      sourcePath: 'trajectory/provider/deepseek-child-session-1.jsonl',
      sourceDigest: digest('child'),
      sessionId: 'session-child',
      parentSessionId: 'session-main',
      delegationDepth: 1,
    })
    const use = extractTrialModificationUse(
      [changed()],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([]), child]),
    )
    expect(runtimeSkillBody(SKILL, SKILL_NAME)).toBe(SKILL_BODY)
    expect(use.status).toBe('observed')
    expect(use.source).toMatchObject({ coverage: 'listed-files-complete', mainSessionFiles: 1, childSessionFiles: 1 })
    expect(use.artifacts[0]).toMatchObject({ status: 'observed', observedActionCount: 1, failedActionCount: 0 })
    expect(use.artifacts[0]!.actions[0]).toMatchObject({
      sessionId: 'session-child', sourcePath: child.sourcePath, sourceDigest: child.sourceDigest,
      callSeq: 10, resultSeq: 11, callId, match: 'skill-name-and-body',
    })
  })

  it('requires the exact structured name, paired result envelope, and candidate body', () => {
    const bodyMention = file([
      { type: 'user/message', seq: 1, data: { source: { kind: 'human' }, content: skillOutput() } },
      { type: 'tool/call', seq: 2, data: { callId: 'bash', name: 'bash', arguments: `echo ${SKILL_NAME}` } },
      resultEvent('unrelated', [{ type: 'text', text: skillOutput() }], false, 3),
      { type: 'request/header', seq: 4, data: { header: { model: SKILL } } },
    ])
    const absent = extractTrialModificationUse(
      [changed()], 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', trace([bodyMention]),
    )
    expect(absent.artifacts[0]).toMatchObject({ status: 'not-observed', observedActionCount: 0 })

    const mismatched = file([
      { type: 'tool/call', seq: 5, data: { callId: 'call', name: 'skill', arguments: { name: SKILL_NAME } } },
      resultEvent('call', [{ type: 'text', text: skillOutput('an older body') }], false, 6),
    ])
    expect(extractTrialModificationUse(
      [changed()], 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', trace([mismatched]),
    ).artifacts[0]?.status).toBe('unknown')
  })

  it('uses the matched nested tool-result status for failed attempts', () => {
    const call = { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'skill', arguments: { name: SKILL_NAME } } }
    const successful = extractTrialModificationUse(
      [changed()],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([call, resultEvent('call', [{ type: 'text', text: skillOutput() }, { error: 'application data' }])])]),
    )
    expect(successful.status).toBe('observed')

    const failed = extractTrialModificationUse(
      [changed()],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([call, resultEvent('call', [{ type: 'text', text: 'failed' }], true)])]),
    )
    expect(failed.artifacts[0]).toMatchObject({ status: 'attempted-failure', failedActionCount: 1 })
    expect(failed.artifacts[0]!.actions[0]?.match).toBe('skill-name-attempt')
  })

  it('matches exact generic reads and model-visible system injection without treating unsupported execution as absence', () => {
    const content = 'export const changed = true\n'
    const artifact = changed('tools/checked.ts', content)
    const call = { type: 'tool/call', seq: 1, data: { callId: 'read', name: 'read', arguments: { path: 'tools/checked.ts' } } }
    const readUse = extractTrialModificationUse(
      [artifact],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([call, resultEvent('read', [{ type: 'text', text: content }])])]),
    )
    expect(readUse.artifacts[0]).toMatchObject({ status: 'observed', observedActionCount: 1 })
    expect(readUse.artifacts[0]!.actions[0]?.match).toBe('artifact-path-and-content')

    const injected = extractTrialModificationUse(
      [artifact],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([{ type: 'request/header', seq: 1, data: { header: { system: [{ text: content }] } } }])]),
    )
    expect(injected.artifacts[0]?.status).toBe('observed')
    expect(injected.artifacts[0]!.actions[0]?.action).toBe('injected')

    const hook = extractTrialModificationUse(
      [changed('hooks/verify.ts', content)],
      'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trace([file([{ type: 'tool/call', seq: 1, data: { callId: 'verify', name: 'verify', arguments: {} } }])]),
    )
    expect(hook.artifacts[0]).toMatchObject({ status: 'unknown', reason: 'unsupported-artifact' })
  })

  it('keeps an unmatched artifact unknown when native file coverage is partial', () => {
    const use = extractTrialModificationUse(
      [changed()], 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', trace([file([])], 'partial'),
    )
    expect(use.artifacts[0]).toMatchObject({ status: 'unknown', reason: 'unverified-content' })
    expect(use.source.coverage).toBe('partial')
  })

  it('aggregates valid paired rewards by use status while excluding invalid pairs from means', () => {
    const base = {
      schemaVersion: 1,
      recordId: 'seed_experience_test',
      seedProjectionDigest: digest('old projection'),
      source: {
        evolutionId: 'evolution', roundId: 'round', candidateId: 'candidate',
        parentCandidateId: 'parent-candidate',
        parentHarnessRef: 'a'.repeat(40), candidateHarnessRef: 'b'.repeat(40),
        parentBaselineEvalId: 'eval_parent', candidateEvalId: 'eval_candidate',
        parentRevisionIdentity: digest('parent revision'), candidateRevisionIdentity: digest('candidate revision'),
        seedConditionId: digest('condition'),
      },
      applicability: {
        model: 'model', provider: 'provider', datasetDigest: digest('dataset'),
        rolloutProviderDigest: digest('rollout'), toolchainDigest: digest('toolchain'),
      },
      proposal: { rationale: 'rationale', expectedOutcome: 'outcome', semanticTargets: ['skill'] },
      change: { patchDigest: digest('patch'), totalBytes: 1, files: [{ path: SKILL_PATH, change: 'created', additions: 1, deletions: 0 }] },
      observation: {
        comparison: 'candidate-vs-its-parent-seed', planned: 3, valid: 2, excluded: 1,
        baselineInvalid: 0, candidateInvalid: 1, baselineMean: 0.5, candidateMean: 0.5, meanRewardDelta: 0,
        taskResults: [
          { valid: true, trialKey: 'gain', taskName: 'gain', baseline: { runId: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed', reward: 0 }, candidate: { runId: 'run_11111111111111111111111111111111', status: 'completed', reward: 1 }, rewardDelta: 1 },
          { valid: true, trialKey: 'loss', taskName: 'loss', baseline: { runId: 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed', reward: 1 }, candidate: { runId: 'run_22222222222222222222222222222222', status: 'completed', reward: 0 }, rewardDelta: -1 },
        ],
        excludedTaskResults: [{ valid: false, trialKey: 'excluded', taskName: 'gain', baseline: { status: 'missing' }, candidate: { runId: 'run_33333333333333333333333333333333', status: 'errored' }, reasons: ['candidate-invalid'] }],
      },
      classification: { execution: 'evaluated', effect: 'mixed', coverage: 'partial', gainedTasks: ['gain'], regressedTasks: ['loss'], unchangedTasks: [] },
      recordDigest: digest('old record'),
    } as SeedExperienceRecord
    const observedTrace1 = trace([file([
      { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'skill', arguments: { name: SKILL_NAME } } },
      resultEvent('call', [{ type: 'text', text: skillOutput() }]),
    ])], 'listed-files-complete', 'run_11111111111111111111111111111111')
    const absentTrace = trace([file([])], 'listed-files-complete', 'run_22222222222222222222222222222222')
    const observedTrace3 = trace([file([
      { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'skill', arguments: { name: SKILL_NAME } } },
      resultEvent('call', [{ type: 'text', text: skillOutput() }]),
    ])], 'listed-files-complete', 'run_33333333333333333333333333333333')
    const enriched = enrichSeedExperienceUse(base, [changed()], new Map([
      ['run_11111111111111111111111111111111', observedTrace1],
      ['run_22222222222222222222222222222222', absentTrace],
      ['run_33333333333333333333333333333333', observedTrace3],
    ]))
    expect(enriched.observation.modificationUse?.statusCounts).toEqual({
      observed: 2, 'attempted-failure': 0, 'not-observed': 1, unknown: 0,
    })
    expect(enriched.observation.modificationUse?.conditionedResults).toContainEqual(expect.objectContaining({
      status: 'observed', validPairs: 1, taskCount: 1, baselineMean: 0, candidateMean: 1, meanRewardDelta: 1,
    }))
  })
})

async function nativeFile(root: string, runId: string, path: string, events: unknown[]): Promise<{ role: string; path: string; media_type: string; sha256: string; bytes: number }> {
  const content = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  const target = join(root, 'runs', runId, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content)
  return { role: 'provider_events', path, media_type: 'application/x-ndjson', sha256: digest(content), bytes: Buffer.byteLength(content) }
}

describe('Hitch native experience usage reader', () => {
  it('verifies manifest-listed main and child files and retains exact evidence events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-native-use-'))
    roots.push(root)
    const runId = 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const callId = 'child-call'
    const main = await nativeFile(root, runId, 'trajectory/provider/deepseek-session.jsonl', [
      { type: 'session', version: 0, id: 'session-main', delegationDepth: 0 },
      { type: 'tool/call', seq: 1, data: { callId: 'bash', name: 'bash', arguments: 'large unrelated output' } },
      resultEvent('bash', [{ type: 'text', text: 'ignored' }]),
    ])
    const child = await nativeFile(root, runId, 'trajectory/provider/deepseek-child-session-1.jsonl', [
      { type: 'session', version: 0, id: 'session-child', parentSession: 'session-main', delegationDepth: 1 },
      { type: 'tool/call', seq: 1, data: { callId, name: 'skill', arguments: JSON.stringify({ name: SKILL_NAME }) } },
      resultEvent(callId, [{ type: 'text', text: skillOutput() }]),
    ])
    await writeFile(join(root, 'runs', runId, 'trajectory.ref.json'), JSON.stringify({
      schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek',
      provider_session_id: 'session-main', files: [main, child],
    }))
    const reads = await new HitchNativeExperienceUsageReader({ root }).readRuns([runId], new AbortController().signal)
    const read = reads.get(runId)!
    expect(read.available).toBe(true)
    if (!read.available) return
    expect(read.trace).toMatchObject({ listedFiles: 2, mainSessionFiles: 1, childSessionFiles: 1, coverage: 'listed-files-complete' })
    expect(read.trace.files.flatMap(item => item.events)).toHaveLength(2)
    expect(extractTrialModificationUse([changed()], runId, read).status).toBe('observed')
  })

  it('excludes orphan child evidence and reports partial coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-native-orphan-'))
    roots.push(root)
    const runId = 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const main = await nativeFile(root, runId, 'trajectory/provider/deepseek-session.jsonl', [
      { type: 'session', version: 0, id: 'session-main', delegationDepth: 0 },
    ])
    const child = await nativeFile(root, runId, 'trajectory/provider/deepseek-child-session-1.jsonl', [
      { type: 'session', version: 0, id: 'foreign-child', parentSession: 'foreign-main', delegationDepth: 1 },
      { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'skill', arguments: { name: SKILL_NAME } } },
      resultEvent('call', [{ type: 'text', text: skillOutput() }]),
    ])
    await writeFile(join(root, 'runs', runId, 'trajectory.ref.json'), JSON.stringify({
      schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek',
      provider_session_id: 'session-main', files: [main, child],
    }))
    const read = (await new HitchNativeExperienceUsageReader({ root }).readRuns([runId], new AbortController().signal)).get(runId)!
    expect(read.available).toBe(true)
    if (!read.available) return
    expect(read.trace).toMatchObject({ coverage: 'partial', reason: 'native-source-invalid' })
    expect(read.trace.files.map(item => item.sessionId)).toEqual(['session-main'])
    expect(extractTrialModificationUse([changed()], runId, read).status).toBe('unknown')
  })

  it('does not expose a source whose bytes fail its manifest digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-native-digest-'))
    roots.push(root)
    const runId = 'run_cccccccccccccccccccccccccccccccc'
    const main = await nativeFile(root, runId, 'trajectory/provider/deepseek-session.jsonl', [
      { type: 'session', version: 0, id: 'session-main', delegationDepth: 0 },
    ])
    main.sha256 = digest('different')
    await writeFile(join(root, 'runs', runId, 'trajectory.ref.json'), JSON.stringify({
      schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek',
      provider_session_id: 'session-main', files: [main],
    }))
    const read = (await new HitchNativeExperienceUsageReader({ root }).readRuns([runId], new AbortController().signal)).get(runId)
    expect(read).toMatchObject({ available: false, reason: 'native-source-digest-mismatch', verifiedFiles: 0 })
  })

  it('shares the snapshot byte budget across runs and retries a budget miss later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-native-budget-'))
    roots.push(root)
    const runIds = [
      'run_11111111111111111111111111111111',
      'run_22222222222222222222222222222222',
    ]
    let sourceBytes = 0
    for (const runId of runIds) {
      const main = await nativeFile(root, runId, 'trajectory/provider/deepseek-session.jsonl', [
        { type: 'session', version: 0, id: 'session-main', delegationDepth: 0 },
      ])
      sourceBytes = main.bytes
      await writeFile(join(root, 'runs', runId, 'trajectory.ref.json'), JSON.stringify({
        schema_version: '2', run_id: runId, fidelity: 'provider_native', provider: 'deepseek',
        provider_session_id: 'session-main', files: [main],
      }))
    }
    const reader = new HitchNativeExperienceUsageReader({ root, maxSnapshotBytes: sourceBytes })
    const first = await reader.readRuns(runIds, new AbortController().signal)
    expect(first.get(runIds[0]!)).toMatchObject({ available: true })
    expect(first.get(runIds[1]!)).toMatchObject({ available: false, reason: 'snapshot-byte-limit' })
    expect(extractTrialModificationUse([changed()], runIds[1], first.get(runIds[1]!)).status).toBe('unknown')

    const retried = await reader.readRuns([runIds[1]!], new AbortController().signal)
    expect(retried.get(runIds[1]!)).toMatchObject({ available: true })
    expect(extractTrialModificationUse([changed()], runIds[1], retried.get(runIds[1]!)).status).toBe('not-observed')
  })
})
