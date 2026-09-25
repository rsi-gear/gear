import type { ProviderManifest } from '../contracts.js';
import { assertSchema } from '../schema.js';

/** Shared pure admission rule used by both Campaign construction and author profile check. */
export function validateProviderManifest(manifest: ProviderManifest): void {
  if (typeof manifest.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(manifest.kind))
    throw new Error(`Invalid identifier: ${manifest.kind}`);
  if (!/^[a-f0-9]{64}$/.test(manifest.implementationDigest)) throw new Error('Provider implementation digest required');
  if (manifest.supportsInspect !== true || !['trusted-local', 'external'].includes(manifest.execution)
    || (manifest.supportsIdempotentReplay !== undefined && manifest.supportsIdempotentReplay !== true))
    throw new Error('Invalid provider capabilities');
  if (!Array.isArray(manifest.meteredDimensions) || !manifest.meteredDimensions.every(dimension => typeof dimension === 'string')
    || new Set(manifest.meteredDimensions).size !== manifest.meteredDimensions.length)
    throw new Error('Invalid provider metered dimensions');
  for (const dimension of manifest.meteredDimensions)
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(dimension)) throw new Error(`Invalid identifier: ${dimension}`);
  for (const dimension of manifest.hardLimitDimensions ?? [])
    if (!manifest.meteredDimensions.includes(dimension)) throw new Error('Hard limit dimension must be metered');
  assertSchema(manifest.inputSchema);
  assertSchema(manifest.outputSchema);
}
