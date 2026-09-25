import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { replay, type AuthorReplayRequest, type AlgorithmDefinition } from './index.js';
import { canonicalJson } from '../schema.js';

/** One short-lived process per replay. No JS heap or pending Promise survives a decision boundary. */
async function main(): Promise<void> {
  const [modulePath, exportName] = process.argv.slice(2);
  if (!modulePath || !exportName) throw new Error('Author worker needs module and export');
  let raw = '';
  for await (const part of process.stdin) {
    raw += part.toString();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Author worker request exceeds 1 MiB');
  }
  const request = JSON.parse(raw) as AuthorReplayRequest;
  const module = await import(pathToFileURL(resolve(modulePath)).href) as Record<string, unknown>;
  const definition = module[exportName];
  if (typeof definition !== 'function') throw new Error(`Author export ${exportName} is not a function`);
  const reply = await replay(definition as AlgorithmDefinition, request);
  process.stdout.write(`${canonicalJson(reply)}\n`);
}
main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
