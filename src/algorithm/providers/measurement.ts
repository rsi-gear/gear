import type { OperationEnvelope, OperationProvider, ProviderManifest } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { LocalDurableProvider } from '../runtime/providers.js';
import { sealMeasurement, validateMeasurementInput, type MeasurementRecord } from '../data/measurement.js';
import { s3ImplementationDigest } from '../data/identity.js';

export type MeasurementInput = Omit<MeasurementRecord, 'schemaVersion' | 'comparisonKey'>;
/** Must verify metrics and evidence against a trusted evaluator receipt; a recipe cannot self-attest a score. */
export type MeasurementVerifier = (input: MeasurementInput, envelope: OperationEnvelope) => void | Promise<void>;

export function createMeasurementRecordProvider(root: string, artifacts: FileArtifactStore, verifierImplementationDigest: string, verify: MeasurementVerifier): OperationProvider {
  if (typeof verify !== 'function') throw new Error('Measurement verifier required');
  assertDigest(verifierImplementationDigest);
  const manifest: ProviderManifest = { kind: 'measurement.record', implementationDigest: s3ImplementationDigest('measurement.record', { verifierImplementationDigest }), execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
    inputSchema: { type: 'object', required: ['subjectBindings', 'condition', 'evidenceRefs', 'metrics', 'evaluatedAtCursor'], properties: {
      subjectBindings: { type: 'any' }, condition: { type: 'any' }, evidenceRefs: { type: 'array', items: { type: 'any' } },
      metrics: { type: 'object', additionalProperties: { type: 'number' } }, evaluatedAtCursor: { type: 'string' }, reevaluates: { type: 'string' },
    }, additionalProperties: false }, outputSchema: { type: 'object', required: ['measurementRef'], properties: { measurementRef: { type: 'any' } }, additionalProperties: false } };
  const check = (envelope: OperationEnvelope) => {
    const input = envelope.input as MeasurementInput;
    validateMeasurementInput(artifacts, input);
    return verify(input, envelope);
  };
  const local = new LocalDurableProvider(root, manifest, async envelope => {
    await check(envelope);
    const measurementRef = sealMeasurement(artifacts, envelope.input as MeasurementInput);
    return { outcome: { kind: 'result', value: { measurementRef } } };
  });
  return {
    describe: () => local.describe(), preflight: check,
    submit: async envelope => { await check(envelope); return local.submit(envelope); },
    inspect: async envelope => { await check(envelope); return local.inspect(envelope); },
    cancel: async envelope => { await check(envelope); return local.cancel(envelope); },
    collect: async envelope => { await check(envelope); return local.collect(envelope); },
  } satisfies OperationProvider;
}
