import type { BudgetPlan, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js';
import { assertDigest } from '../artifacts.js';
import { LocalDurableProvider } from '../runtime/providers.js';
import type { EvidenceContent, EvidenceGrant, EvidencePage, EvidenceQuery, EvidenceRead } from '../data/evidence.js';
import { EvidenceService } from '../data/evidence.js';
import { s3ImplementationDigest } from '../data/identity.js';
import type { JsonValue } from '../schema.js';

export type EvidenceGrantResolver = (principalId: string) => EvidenceGrant;

function grantFor(resolver: EvidenceGrantResolver, principalId: string): EvidenceGrant {
  const grant = resolver(principalId);
  if (grant.principalId !== principalId) throw new Error('Evidence principal mismatch');
  return grant;
}
class GuardedEvidenceProvider implements OperationProvider {
  constructor(private readonly local: LocalDurableProvider, private readonly check: (envelope: OperationEnvelope) => void) {}
  describe(): ProviderManifest { return this.local.describe(); }
  preflight(envelope: OperationEnvelope): void { this.check(envelope); }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { this.check(envelope); return this.local.submit(envelope); }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { this.check(envelope); return this.local.inspect(envelope); }
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection> { this.check(envelope); return this.local.cancel(envelope); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { this.check(envelope); return this.local.collect(envelope); }
}

/** Campaign access is supplied by the host resolver, never by the operation's JSON input. */
const evidenceDimensions = ['evidence.items', 'evidence.bytes'];
function receipt(envelope: OperationEnvelope, result: EvidencePage | EvidenceContent, source: string | undefined,
  dimensions: string[]): UsageReceipt | undefined {
  if (!source) return undefined;
  const cumulative: Record<string, number> = {};
  if (dimensions.includes('evidence.items')) cumulative['evidence.items'] = result.usage.returnedItems;
  if (dimensions.includes('evidence.bytes')) cumulative['evidence.bytes'] = result.usage.returnedBytes;
  return { source, scope: 'operation', operationId: envelope.operationId, cursor: result.receiptRef.digest, cumulative };
}
export function createEvidenceProviders(root: string, service: EvidenceService, resolveGrant: EvidenceGrantResolver, accessPolicyDigest: string,
  campaignBudget: BudgetPlan): OperationProvider[] {
  assertDigest(accessPolicyDigest);
  const dimensions = evidenceDimensions.filter(dimension => campaignBudget[dimension]);
  const sources = new Set(dimensions.map(dimension => campaignBudget[dimension]!.source));
  if (sources.size > 1) throw new Error('Evidence metered dimensions need a common source');
  if (dimensions.some(dimension => campaignBudget[dimension]!.capability === 'hard')) throw new Error('Evidence hard budgets require a pre-execution limiter');
  const source = sources.values().next().value as string | undefined;
  if (source && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(source)) throw new Error('Invalid evidence meter source');
  const identity = { accessPolicyDigest, source: source ?? null, dimensions, maxPageSize: service.maxPageSize,
    maxReadBytes: service.maxReadBytes, tokenKeyDigest: service.tokenKeyDigest };
  const queryManifest: ProviderManifest = { kind: 'evidence.query', implementationDigest: s3ImplementationDigest('evidence.query', identity), execution: 'trusted-local', supportsInspect: true, meteredDimensions: dimensions,
    inputSchema: { type: 'object', required: ['viewRef', 'asOf', 'projection', 'pageSize'], properties: {
      viewRef: { type: 'any' }, asOf: { type: 'any' }, projection: { type: 'string', enum: ['overview', 'task-report', 'trace-chunk'] },
      pageSize: { type: 'integer' }, scope: { type: 'any' }, pageToken: { type: 'string' },
    }, additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: true } };
  const readManifest: ProviderManifest = { kind: 'evidence.read', implementationDigest: s3ImplementationDigest('evidence.read', identity), execution: 'trusted-local', supportsInspect: true, meteredDimensions: dimensions,
    inputSchema: { type: 'object', required: ['viewRef', 'asOf', 'contentDigest'], properties: {
      viewRef: { type: 'any' }, asOf: { type: 'any' }, contentDigest: { type: 'string' }, range: { type: 'any' },
    }, additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: true } };
  const query = new LocalDurableProvider(`${root}/query`, queryManifest, envelope => {
    const page = service.query(envelope.input as EvidenceQuery, grantFor(resolveGrant, envelope.campaignId));
    const usageReceipt = receipt(envelope, page, source, dimensions);
    return { outcome: { kind: 'result', value: page as unknown as JsonValue }, ...(usageReceipt ? { receipt: usageReceipt } : {}) };
  });
  const read = new LocalDurableProvider(`${root}/read`, readManifest, envelope => {
    const content = service.read(envelope.input as EvidenceRead, grantFor(resolveGrant, envelope.campaignId));
    const usageReceipt = receipt(envelope, content, source, dimensions);
    return { outcome: { kind: 'result', value: content as unknown as JsonValue }, ...(usageReceipt ? { receipt: usageReceipt } : {}) };
  });
  return [new GuardedEvidenceProvider(query, envelope => service.checkQuery(envelope.input as EvidenceQuery, grantFor(resolveGrant, envelope.campaignId))),
    new GuardedEvidenceProvider(read, envelope => service.checkRead(envelope.input as EvidenceRead, grantFor(resolveGrant, envelope.campaignId)))];
}

/** Role tools use exactly the same validation, page tokens, artifacts and receipts as recipe operations. */
export function createRoleEvidenceTools(service: EvidenceService, resolveGrant: EvidenceGrantResolver, roleId: string): {
  query(request: EvidenceQuery): EvidencePage;
  read(request: EvidenceRead): EvidenceContent;
} {
  if (!roleId) throw new Error('Role identity required');
  return {
    query: request => service.query(request, grantFor(resolveGrant, roleId)),
    read: request => service.read(request, grantFor(resolveGrant, roleId)),
  };
}
