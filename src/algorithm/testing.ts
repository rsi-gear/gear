export { LocalDurableProvider, BindingDeriveProvider } from './runtime/providers.js';
export type { LocalProviderHandler, LocalProviderFaults } from './runtime/providers.js';
export { CampaignStore } from './runtime/store.js';

import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection } from './contracts.js';
import { canonicalJson } from './schema.js';

/** Run against disposable provider state; submit and cancel may perform real work. */
export async function probeProviderReplay(factory: () => OperationProvider, envelope: OperationEnvelope): Promise<{ first: ProviderInspection; recovered: ProviderInspection }> {
  const firstProvider = factory();
  const first = await firstProvider.inspect(envelope);
  if (first.status !== 'not-started') throw new Error('Replay probe requires a fresh operation');
  let submitted: CompletionEnvelope | undefined;
  try { const response = await firstProvider.submit(envelope); if (response.status === 'completed') submitted = response.completion; }
  catch { /* Lost reply is permitted; inspect must reconcile without another key. */ }
  const recoveredProvider = factory();
  const recovered = await recoveredProvider.inspect(envelope);
  if (submitted && (recovered.status !== 'completed' || canonicalJson(recovered.completion) !== canonicalJson(submitted))) throw new Error('Provider lost committed completion on restart');
  if (recovered.status === 'not-started') throw new Error('Provider forgot submitted operation');
  if (recovered.status === 'completed') {
    const duplicate = await recoveredProvider.submit(envelope);
    if (duplicate.status !== 'completed' || canonicalJson(duplicate.completion) !== canonicalJson(recovered.completion)) throw new Error('Duplicate submit changed completion');
  }
  const drift = { ...envelope, inputDigest: envelope.inputDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
  let rejected = false;
  try { await recoveredProvider.submit(drift); } catch { rejected = true; }
  if (!rejected) throw new Error('Provider accepted same key with changed input digest');
  return { first, recovered };
}

export async function probeProviderNoResult(factory: () => OperationProvider, envelope: OperationEnvelope): Promise<void> {
  const result = await probeProviderReplay(factory, envelope);
  if (result.recovered.status !== 'completed' || result.recovered.completion.outcome.kind !== 'no-result') throw new Error('Provider did not preserve no-result');
}

export async function probeProviderReceipt(factory: () => OperationProvider, envelope: OperationEnvelope): Promise<void> {
  const result = await probeProviderReplay(factory, envelope);
  if (result.recovered.status !== 'completed' || !result.recovered.completion.receipt) throw new Error('Provider did not preserve usage receipt');
  const repeated = await factory().inspect(envelope);
  if (repeated.status !== 'completed' || canonicalJson(repeated.completion.receipt) !== canonicalJson(result.recovered.completion.receipt)) throw new Error('Provider changed receipt on repeated inspect');
}

export async function probeProviderCancellation(factory: () => OperationProvider, envelope: OperationEnvelope): Promise<ProviderInspection> {
  const provider = factory();
  const result = await provider.cancel(envelope);
  if (result.status !== 'cancelled' && result.status !== 'running' && result.status !== 'unknown' && result.status !== 'completed') throw new Error('Invalid cancellation response');
  if (result.status === 'cancelled' && typeof result.releaseConfirmed !== 'boolean') throw new Error('Cancellation omitted release confirmation');
  return result;
}
