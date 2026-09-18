import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelTrainingCoordinator, trainingCompatibilityDigest } from '../../../src/training/coordinator.js'
import { digestJson } from '../../../src/training/digest.js'
import { jsonProcess } from '../../../src/training/process.js'
import { parseModelTrainingSpec, parseTrainingRequest } from '../../../src/training/schema.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import type { ModelTrainingSpecV1, ModelTrainingSpecV2, TrainingRuntimeLockV2 } from '../../../src/training/types.js'
import { fixture, FixtureEvaluator, FixtureTrainer } from './fixture.js'
import { v2spec } from './placement-fixture.js'

describe('versioned process training runtime lock', () => {
  let root: string, store: ModelTrainingStore, legacy: ModelTrainingSpecV1, spec: ModelTrainingSpecV2
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-runtime-lock-')); store = new ModelTrainingStore(root); legacy = await fixture(store); spec = v2spec(legacy)
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))
  const processLock = (value: ModelTrainingSpecV2): TrainingRuntimeLockV2 => {
    if (value.trainer.runtimeLock.schemaVersion !== 1) throw new Error('fixture requires a legacy lock')
    const { imageDigest: _, ...lock } = value.trainer.runtimeLock
    return { ...lock, schemaVersion: 2, runtime: { kind: 'python-env', nodeRuntimeDigest: value.deployment.modelRuntime.runtimeDigest, outerImageDigest: null },
      validation: 'pending-gpu', probeEvidenceRefs: [] }
  }
  it('preserves both existing v1 and v2 experiments with the original lock byte for byte', () => {
    for (const original of [legacy, spec]) {
      const bytes = JSON.stringify(original)
      expect(JSON.stringify(parseModelTrainingSpec(original))).toBe(bytes)
      expect(digestJson(parseModelTrainingSpec(original))).toBe(digestJson(original))
      expect(original.trainer.runtimeLock.schemaVersion).toBe(1)
    }
  })
  it('admits a pure process environment and carries its exact lock only to the train projection', async () => {
    spec.trainer.runtimeLock = processLock(spec)
    const coordinator = new ModelTrainingCoordinator(store, new FixtureTrainer(store), new FixtureEvaluator(store))
    const experiment = await coordinator.createExperiment(spec), run = await coordinator.admit(experiment.id)
    expect(parseTrainingRequest(run.request).trainer.runtimeLock).toEqual(spec.trainer.runtimeLock)
    expect(run.request).not.toHaveProperty('datasets')
    expect(JSON.stringify(run.request)).not.toContain('heldOut')
    expect((await store.load(experiment.id)).specDigest).toBe(digestJson(spec))
    const previous = structuredClone(run.request); previous.trainer.runtimeLock = legacy.trainer.runtimeLock
    expect(trainingCompatibilityDigest(previous)).not.toBe(trainingCompatibilityDigest(run.request))
    const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
    const actual = await jsonProcess(['env', `PYTHONPATH=${resolve('python')}`, python], ['-c',
      'import json,sys\nfrom gear_training.preflight import compatibility_digest\nprint(json.dumps(compatibility_digest(json.load(sys.stdin))))'], run.request)
    expect(actual).toBe(trainingCompatibilityDigest(run.request))
  })
  it('rejects a process lock in v1, a mismatched frozen environment, or undeclared runtime fields', () => {
    const lock = processLock(spec)
    legacy.trainer.runtimeLock = lock
    expect(() => parseModelTrainingSpec(legacy)).toThrow('original container runtime lock')
    spec.trainer.runtimeLock = lock
    lock.runtime.nodeRuntimeDigest = digestJson('other environment')
    expect(() => parseModelTrainingSpec(spec)).toThrow('frozen process model node')
    lock.runtime.nodeRuntimeDigest = spec.deployment.modelRuntime.runtimeDigest
    Object.assign(lock, { imageDigest: digestJson('unversioned-image') })
    expect(() => parseModelTrainingSpec(spec)).toThrow()
  })
  it('allows an explicitly pinned outer image without inventing one for pure process installs', () => {
    const lock = processLock(spec); spec.trainer.runtimeLock = lock
    expect(parseModelTrainingSpec(spec).trainer.runtimeLock).toEqual(lock)
    lock.runtime.outerImageDigest = digestJson('provider-outer-image')
    expect(parseModelTrainingSpec(spec).trainer.runtimeLock).toEqual(lock)
    Object.assign(lock.runtime, { outerImageDigest: 'mutable:latest' })
    expect(() => parseModelTrainingSpec(spec)).toThrow()
  })
})
