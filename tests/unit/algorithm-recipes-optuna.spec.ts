import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AlgorithmRuntime, BindingStore, FileArtifactStore, LocalDurableProvider, jsonDigest } from '../../src/algorithm/index.js';
import { PythonOperationProvider } from '../../src/algorithm/components.js';
import { loadPythonAlgorithm, loadPythonProvider } from '../../src/algorithm/loader.js';

const interpreter = process.env.GEAR_ALGORITHM_OPTUNA_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const sdkPath = resolve('packages/python-sdk/src');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(!interpreter)('runs two Optuna asks around Gear evaluation operations and resumes a lost reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-optuna-campaign-'));
  roots.push(root);
  await writeFile(join(root, 'providers.py'), [
    'from gear_algorithm.adapters.optuna import OptunaAskProvider, OptunaTellProvider',
    "KEY = b'optuna-campaign-checkpoint-key-32bytes'",
    'ask_provider = OptunaAskProvider(checkpoint_key=KEY)',
    'tell_provider = OptunaTellProvider(checkpoint_key=KEY)',
    '',
  ].join('\n'));
  const stateRoot = join(root, '.gear', 'study');
  await mkdir(stateRoot, { recursive: true });
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
  const bindings = new BindingStore(artifacts, { id: 'optuna.bindings.v1', slots: {} });
  const initialBindingSetRef = bindings.create({});
  const config = { studyName: 'two-geared-trials', direction: 'minimize', sampler: 'random',
    seed: 17, space: { x: { type: 'float', low: -1, high: 1 } }, trials: 2,
    evaluationKind: 'experiment.evaluate',
    operationLimits: { 'experiment.evaluate': { 'evaluation.calls': 1 } } };
  const spec = { campaignId: 'optuna-two-trials', config, initialBindingSetRef,
    budget: { 'evaluation.calls': { unit: 'call', limit: 2, source: 'experiment.evaluate', capability: 'stop' as const } } };
  let actualEvaluations = 0;
  const evaluationManifest = { kind: 'experiment.evaluate', implementationDigest: jsonDigest('controlled-evaluation-v1'),
    execution: 'trusted-local' as const, supportsInspect: true as const, meteredDimensions: ['evaluation.calls'],
    inputSchema: { type: 'object' as const, properties: { trialNumber: { type: 'integer' as const },
      params: { type: 'object' as const, additionalProperties: { type: 'any' as const } } },
    required: ['trialNumber', 'params'], additionalProperties: false },
    outputSchema: { type: 'object' as const, properties: { objective: { type: 'number' as const } },
      required: ['objective'], additionalProperties: false } };
  const makeRuntime = async (dropEvaluationReply: boolean) => {
    const algorithm = await loadPythonAlgorithm({ configDir: root, module: 'gear_algorithm.recipes.optuna_search',
      export: 'algorithm', interpreter: interpreter!, sdkPath });
    const ask = await loadPythonProvider({ configDir: root, module: './providers.py', export: 'ask_provider',
      interpreter: interpreter!, sdkPath, artifactBridge: artifacts, recordDir: join(stateRoot, 'ask') });
    const tell = await loadPythonProvider({ configDir: root, module: './providers.py', export: 'tell_provider',
      interpreter: interpreter!, sdkPath, artifactBridge: artifacts, recordDir: join(stateRoot, 'tell') });
    const evaluation = new LocalDurableProvider(join(stateRoot, 'evaluation'), evaluationManifest, envelope => {
      actualEvaluations++;
      const x = (envelope.input as { params: { x: number } }).params.x;
      return { outcome: { kind: 'result', value: { objective: (x - 0.25) ** 2 } },
        receipt: { source: 'experiment.evaluate', scope: 'operation', operationId: envelope.operationId,
          cursor: 'final', cumulative: { 'evaluation.calls': 1 } } };
    }, { dropSubmitResponseOnce: dropEvaluationReply });
    return { runtime: new AlgorithmRuntime(stateRoot, algorithm.value,
      [new PythonOperationProvider(ask.value, ask.worker), new PythonOperationProvider(tell.value, tell.worker),
        evaluation], spec),
      close: async () => { await Promise.all([algorithm.close(), ask.close(), tell.close()]); } };
  };

  const first = await makeRuntime(true);
  try {
    expect(await first.runtime.runUntilBlocked()).toBe('waiting');
    expect(first.runtime.snapshot()?.phase).not.toBe('complete');
  } finally { await first.close(); }
  const second = await makeRuntime(false);
  try {
    expect(await second.runtime.runUntilBlocked()).toBe('complete');
    const snapshot = second.runtime.snapshot()!;
    expect((snapshot.state as any).finished).toHaveLength(2);
    expect((snapshot.state as any).finished.map((trial: any) => trial.trialNumber)).toEqual([0, 1]);
    expect(actualEvaluations).toBe(2);
    expect(snapshot.spent['evaluation.calls']).toBe(2);
    expect((await readdir(join(stateRoot, 'ask'))).filter(name => name.endsWith('.json'))).toHaveLength(2);
    expect((await readdir(join(stateRoot, 'tell'))).filter(name => name.endsWith('.json'))).toHaveLength(2);
  } finally { await second.close(); }
});
