import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const files = ['contracts', 'schema', 'artifacts', 'bindings', 'steps', 'runtime/engine', 'runtime/store', 'runtime/persistence', 'runtime/providers', 'runtime/identity'];

/** Exact source/build closure used by the persisted kernel, independent of package metadata. */
export function kernelImplementationDigest(root = dirname(dirname(fileURLToPath(import.meta.url)))): string {
  const extension = extname(fileURLToPath(import.meta.url));
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = `${file}${extension}`;
    const bytes = readFileSync(join(root, relative));
    hash.update(relative); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}
