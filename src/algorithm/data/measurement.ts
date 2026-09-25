import type { ArtifactRef, BindingSetRef } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { readTaskView, type TaskViewRef } from './tasks.js';

export type MeasurementCondition = {
  taskViewRef: TaskViewRef;
  providerImplementationDigest: string;
  evaluatorRef: ArtifactRef;
  rubricRef: ArtifactRef;
  environmentRef: ArtifactRef;
  samplingRef: ArtifactRef;
  budgetRef: ArtifactRef;
  metricSchemaRef: ArtifactRef;
  subjectSchemaId: string;
};
export type MeasurementRecord = {
  schemaVersion: 1;
  subjectBindings: BindingSetRef;
  condition: MeasurementCondition;
  comparisonKey: string;
  evidenceRefs: ArtifactRef[];
  metrics: Record<string, number>;
  evaluatedAtCursor: string;
  reevaluates?: string;
};
export type MeasurementRef = ArtifactRef;
export type MetricSchema = { schemaVersion: 1; metrics: Record<string, { unit: string; minimum?: number; maximum?: number }> };

function validateMetrics(artifacts: FileArtifactStore, schemaRef: ArtifactRef, metrics: Record<string, number>): void {
  if (schemaRef.schemaId !== 'measurement.metric-schema.v1') throw new Error('Measurement metric schema identity missing');
  const schema = artifacts.getJson(schemaRef) as unknown as MetricSchema;
  if (schema.schemaVersion !== 1 || !schema.metrics || typeof schema.metrics !== 'object' || Array.isArray(schema.metrics)
    || Object.keys(schema.metrics).length === 0 || Object.keys(schema.metrics).sort().join('\0') !== Object.keys(metrics).sort().join('\0')) throw new Error('Measurement metric names differ from schema');
  for (const [name, rule] of Object.entries(schema.metrics)) {
    const value = metrics[name];
    if (!name || !rule || typeof rule.unit !== 'string' || !rule.unit || typeof value !== 'number' || !Number.isFinite(value)
      || rule.minimum !== undefined && (!Number.isFinite(rule.minimum) || value < rule.minimum)
      || rule.maximum !== undefined && (!Number.isFinite(rule.maximum) || value > rule.maximum)) throw new Error(`Invalid measurement metric ${name}`);
  }
}

export function measurementComparisonKey(condition: MeasurementCondition): string {
  assertDigest(condition.providerImplementationDigest);
  if (!condition.subjectSchemaId) throw new Error('Measurement subject schema required');
  return jsonDigest({ taskView: condition.taskViewRef.digest, provider: condition.providerImplementationDigest,
    evaluator: condition.evaluatorRef.digest, rubric: condition.rubricRef.digest, environment: condition.environmentRef.digest,
    sampling: condition.samplingRef.digest, budget: condition.budgetRef.digest, metricSchema: condition.metricSchemaRef.digest,
    subjectSchema: condition.subjectSchemaId });
}
/** Pure admission validation, before a durable provider claims an operation. */
export function validateMeasurementInput(artifacts: FileArtifactStore,
  input: Omit<MeasurementRecord, 'schemaVersion' | 'comparisonKey'>): void {
  measurementComparisonKey(input.condition);
  if (!input.evaluatedAtCursor || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) throw new Error('Invalid measurement');
  if (input.subjectBindings.kind !== 'binding-set' || input.subjectBindings.schemaId !== input.condition.subjectSchemaId) throw new Error('Measurement subject binding schema mismatch');
  artifacts.getJsonByDigest(input.subjectBindings.digest, `binding-set:${input.subjectBindings.schemaId}`);
  readTaskView(artifacts, input.condition.taskViewRef);
  for (const child of [input.condition.evaluatorRef, input.condition.rubricRef, input.condition.environmentRef,
    input.condition.samplingRef, input.condition.budgetRef, input.condition.metricSchemaRef, ...input.evidenceRefs]) artifacts.getBytes(child);
  validateMetrics(artifacts, input.condition.metricSchemaRef, input.metrics);
  if (input.reevaluates) {
    const previous = artifacts.getJsonByDigest(input.reevaluates, 'measurement.record.v1') as unknown as MeasurementRecord;
    if (previous.schemaVersion !== 1 || previous.comparisonKey !== measurementComparisonKey(previous.condition)) throw new Error('Invalid reevaluated measurement');
    if (previous.subjectBindings.digest !== input.subjectBindings.digest || previous.condition.taskViewRef.digest !== input.condition.taskViewRef.digest) throw new Error('Reevaluation subject or tasks changed');
  }
}
export function readMeasurement(artifacts: FileArtifactStore, ref: MeasurementRef): MeasurementRecord {
  if (ref.schemaId !== 'measurement.record.v1') throw new Error('Not a measurement record');
  const record = artifacts.getJson(ref) as unknown as MeasurementRecord;
  if (record.schemaVersion !== 1 || !record.evaluatedAtCursor || !Array.isArray(record.evidenceRefs)
    || record.evidenceRefs.length === 0 || !record.metrics || Object.keys(record.metrics).length === 0) throw new Error('Invalid measurement');
  if (record.subjectBindings.kind !== 'binding-set' || record.subjectBindings.schemaId !== record.condition.subjectSchemaId) throw new Error('Measurement subject binding schema mismatch');
  artifacts.getJsonByDigest(record.subjectBindings.digest, `binding-set:${record.subjectBindings.schemaId}`);
  readTaskView(artifacts, record.condition.taskViewRef);
  for (const child of [record.condition.evaluatorRef, record.condition.rubricRef, record.condition.environmentRef,
    record.condition.samplingRef, record.condition.budgetRef, record.condition.metricSchemaRef, ...record.evidenceRefs]) artifacts.getBytes(child);
  if (record.comparisonKey !== measurementComparisonKey(record.condition)) throw new Error('Measurement comparison identity mismatch');
  validateMetrics(artifacts, record.condition.metricSchemaRef, record.metrics);
  if (record.reevaluates) assertDigest(record.reevaluates);
  return record;
}

/** A new evaluator or rubric creates a new record; the previous evidence remains immutable. */
export function sealMeasurement(artifacts: FileArtifactStore, input: Omit<MeasurementRecord, 'schemaVersion' | 'comparisonKey'>): MeasurementRef {
  validateMeasurementInput(artifacts, input);
  const record: MeasurementRecord = { ...input, schemaVersion: 1, comparisonKey: measurementComparisonKey(input.condition) };
  const ref = artifacts.putJson(record as unknown as JsonValue, 'measurement.record.v1');
  readMeasurement(artifacts, ref);
  return ref;
}

export function compareMeasurements(artifacts: FileArtifactStore, leftRef: MeasurementRef, rightRef: MeasurementRef): Record<string, number> {
  const left = readMeasurement(artifacts, leftRef), right = readMeasurement(artifacts, rightRef);
  if (left.comparisonKey !== right.comparisonKey || canonicalJson(Object.keys(left.metrics).sort()) !== canonicalJson(Object.keys(right.metrics).sort())) {
    throw new Error('Measurements are not directly comparable');
  }
  return Object.fromEntries(Object.keys(left.metrics).sort().map(metric => [metric, right.metrics[metric]! - left.metrics[metric]!]));
}
