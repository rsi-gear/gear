import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { AuthorReplayRequest, AuthorReplayReply, AlgorithmDefinition } from './index.js';
import { canonicalJson } from '../schema.js';
import { sealedTreeDigest } from './identity.js';

/** One short-lived process per replay. No JS heap or pending Promise survives a decision boundary. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const describeOnly = args.at(-1) === '--describe';
  if (describeOnly) args.pop();
  const [modulePath, exportName, sdkEntryUrl, sdkEntryDigest, emitRoot, emitDigest, sdkRoot, sdkDigest] = args;
  if (!modulePath || !exportName) throw new Error('Author worker needs module and export');
  if (sdkEntryUrl) {
    if (!sdkEntryDigest || !emitRoot || !emitDigest || !sdkRoot || !sdkDigest)
      throw new Error('Installed author worker identity is incomplete');
    if (sealedTreeDigest(emitRoot) !== emitDigest || sealedTreeDigest(sdkRoot) !== sdkDigest)
      throw new Error('Installed author emit/package bytes changed before worker import');
    const entryPath = new URL(sdkEntryUrl);
    if (entryPath.protocol !== 'file:' || createHash('sha256').update(readFileSync(entryPath)).digest('hex') !== sdkEntryDigest)
      throw new Error('Installed author SDK entry bytes changed before worker import');
  }
  let raw = '';
  if (!describeOnly) {
    for await (const part of process.stdin) {
      raw += part.toString();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Author worker request exceeds 1 MiB');
    }
  }
  const sdk = sdkEntryUrl ? await import(sdkEntryUrl) as { replay?: unknown }
    : await import('./index.js') as { replay?: unknown };
  if (typeof sdk.replay !== 'function') throw new Error('Installed author SDK replay export missing');
  const module = await import(pathToFileURL(resolve(modulePath)).href) as Record<string, unknown>;
  const definition = module[exportName];
  if (typeof definition !== 'function') throw new Error(`Author export ${exportName} is not a function`);
  if (describeOnly) {
    const described = (definition as AlgorithmDefinition & { describe?: () => unknown }).describe;
    if (typeof described !== 'function') throw new Error('Author definition.describe missing');
    process.stdout.write(`${canonicalJson(described())}\n`);
    return;
  }
  const request = JSON.parse(raw) as AuthorReplayRequest;
  const reply = await (sdk.replay as (definition: AlgorithmDefinition, request: AuthorReplayRequest) => Promise<AuthorReplayReply>)(
    definition as AlgorithmDefinition, request);
  process.stdout.write(`${canonicalJson(reply)}\n`);
}
main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
