import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RefineCapabilities } from '../../src/capabilities.js'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import { renderTrajectoryResult } from '../../src/notebook/tool.js'
import { evidence as evidenceFixture, roundFixture } from '../helpers/research-fixture.js'

const fixtureRoot = resolve(
  '.debug/experiments/bb14b103-569d-4192-b9d1-51b26dc65a84/baseline-failures-read-by-meta',
)
const hitchExecutable = '/opt/homebrew/bin/hitch'
const runId = 'run_852ef50411dc4d2fb66be7d602c52eee'
const downloadedRuns = [
  { taskName: 'build-cython-ext', trialName: 'build-cython-ext__CJgdnaf', runId },
  { taskName: 'gcode-to-text', trialName: 'gcode-to-text__foWhgoR', runId: 'run_c5a79500cbf34528810879228c88b7ac' },
  { taskName: 'protein-assembly', trialName: 'protein-assembly__7SPFqc3', runId: 'run_79f9ea225454410fbb908434e270ff9b' },
  { taskName: 'qemu-startup', trialName: 'qemu-startup__zbbs9Fc', runId: 'run_ba4c3c4dda1e45979bf3ce7f7822d62f' },
] as const

describe.skipIf(!existsSync(`${fixtureRoot}/README.md`) || !existsSync(hitchExecutable))(
  'Meta trajectory projection against downloaded production logs',
  () => {
    it('keeps the default card compact and expands long evidence through an opaque ref', async () => {
      const round = roundFixture({ roundId: '52466690-5f1a-4146-8d77-a78fa1680797' })
      const baseline = evidenceFixture(round.plan.seed, round.targetHarnessRef, 0)
      baseline.evalId = 'eval_8fe18c451e984cacb93a3e9ba850333c'
      baseline.completeness = 'complete'
      baseline.primaryReward = 0
      baseline.plannedTrialCount = downloadedRuns.length
      baseline.summary = { total: downloadedRuns.length, passed: 0, failed: downloadedRuns.length, score: 0 }
      baseline.trials = downloadedRuns.map(item => ({
        ...item,
        attempt: 1,
        status: 'completed' as const,
        rewards: { reward: 0 },
      }))
      baseline.invalidTrials = []
      const accesses: unknown[][] = []
      const meta = {
        recordEvidenceAccess: (...args: unknown[]) => { accesses.push(args) },
        proposalEvidenceAudit: () => ({
          summaryAccessed: true,
          accessedRefs: [],
          diagnosedRunRefs: [],
          citedRefs: [],
          diagnosisReceipts: accesses.flatMap(value => {
            const access = value[2] as { diagnosisReceipts?: unknown[] } | undefined
            return access?.diagnosisReceipts ?? []
          }),
        }),
      }
      const store = { async listRounds() { return [round] } }
      const service = { activeEntryForSession: () => ({
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        store,
        meta,
        baseline,
        parentHarnessRef: round.targetHarnessRef,
        parentHarnessDigest: round.targetHarnessDigest,
        workspace: { workspaceId: 'workspace-real-log' },
      }) }
      const reader = new HitchCliEvaluator({
        executable: hitchExecutable,
        harnessId: 'deepseek',
        root: fixtureRoot,
        model: 'unused',
        attempts: 1,
        maxConcurrent: 1,
        setupTimeoutMs: 10_000,
        terminationGraceMs: 100,
        maxOutputBytes: 8 * 1024 * 1024,
        maxTrajectoryOutputBytes: 8 * 1024 * 1024,
        maxTrajectoryAnalysisBytes: 4 * 1024 * 1024,
        maxTrajectoryEventsBytes: 4 * 1024 * 1024,
        sampling: {},
        agentArgs: [],
        passEnv: [],
        repositoryPath: process.cwd(),
      })
      const capabilities = new RefineCapabilities(service as never, {} as never, {
        trajectoryReader: reader,
        maxTrajectoryPageBytes: 16 * 1024,
        maxFailureBundleBytes: 32 * 1024,
      })

      const results = []
      for (const item of downloadedRuns) {
        const result = await capabilities.call('refine-meta', 'meta-real-log', 'trajectory.query', { refs: [item.runId] })
        expect(result).toMatchObject({ runs: [{ task: item.taskName, runId: item.runId }] })
        const transcript = (result as { runs: Array<{ transcript: { text: string } }> }).runs[0]!.transcript.text
        expect(Array.from(transcript).length).toBeLessThanOrEqual(80_000)
        results.push(result)
      }
      const result = results[0]!
      const serialized = JSON.stringify(result)
      const rendered = renderTrajectoryResult(result as never)
      expect(rendered).toContain('TASK build-cython-ext')
      expect(rendered).toContain('VERIFIER · complete')
      expect(Array.from(rendered).length).toBeLessThan(82_000)
      expect(rendered).not.toContain('relevant steps.')
      expect(result).toMatchObject({ runs: [{
        task: 'build-cython-ext',
        runId,
        verifier: {
          status: 'complete',
          summary: '10 passed, 1 failed, 0 skipped.',
          failures: [{ name: 'test_outputs.py::test_repo_cloned' }],
        },
      }] })
      for (const internalField of [
        'canonicalSha256', 'seqStart', 'seqEnd', 'rawEventCount', 'contextEpochs', 'sourceEventSeqs',
      ]) expect(serialized).not.toContain(internalField)

      const diagnosisReceipts = (): unknown[] => accesses.flatMap(value => {
        const access = value[2] as { diagnosisReceipts?: unknown[] } | undefined
        return access?.diagnosisReceipts ?? []
      })
      expect(diagnosisReceipts()).toHaveLength(3)
      const qemuCard = (results[3] as {
        runs: Array<{ verifier: { needsDetail?: true; detailRef?: string } }>
      }).runs[0]!
      expect(qemuCard.verifier).toMatchObject({ needsDetail: true, detailRef: expect.stringMatching(/^detail_/u) })
      const verifierSearch = await capabilities.call('refine-meta', 'meta-real-log', 'trajectory.query', {
        detailRef: qemuCard.verifier.detailRef!, find: 'STDOUT',
      })
      expect(verifierSearch).toMatchObject({
        detail: { matches: expect.arrayContaining([expect.stringContaining('STDOUT')]) },
      })
      expect(diagnosisReceipts()).toHaveLength(3)
      let verifierRef: string | undefined = qemuCard.verifier.detailRef
      let verifierText = ''
      let verifierComplete = false
      while (verifierRef !== undefined) {
        const page = await capabilities.call('refine-meta', 'meta-real-log', 'trajectory.query', {
          detailRef: verifierRef,
        }) as { detail: { text: string; complete: boolean }; nextRef?: string }
        verifierText += page.detail.text
        verifierComplete = page.detail.complete
        expect(JSON.stringify(page)).not.toMatch(/source_bytes|source_sha256|stored_bytes|stored_sha256|media_type/u)
        verifierRef = page.nextRef
      }
      expect(verifierComplete).toBe(true)
      expect(verifierText).toContain('STDOUT test-stdout.txt')
      expect(diagnosisReceipts()).toHaveLength(4)

      const card = (result as {
        runs: Array<{
          transcript: { text: string; earlierRef?: string }
        }>
      }).runs[0]!
      expect(card.transcript.earlierRef).toMatch(/^detail_/u)
      const earlier = await capabilities.call('refine-meta', 'meta-real-log', 'trajectory.query', {
        detailRef: card.transcript.earlierRef!,
      })
      expect(earlier).toMatchObject({ detail: { text: expect.any(String) } })
      const trajectoryRef = card.transcript.text.match(/\[more: (detail_[a-f0-9]+)\]/u)?.[1]
      expect(trajectoryRef).toMatch(/^detail_/u)
      const detail = await capabilities.call('refine-meta', 'meta-real-log', 'trajectory.query', {
        detailRef: trajectoryRef!,
      })
      expect(detail).toMatchObject({ detail: { text: expect.any(String), complete: expect.any(Boolean) } })
      expect(JSON.stringify(detail)).not.toMatch(/canonicalSha256|seqStart|seqEnd|field|offset|cursor/u)
    }, 30_000)
  },
)
