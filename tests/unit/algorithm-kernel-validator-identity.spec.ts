import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelImplementationDigest } from '../../src/algorithm/runtime/identity.js';

const copies: string[] = [];
afterEach(() => { for (const path of copies.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('changes the persisted kernel identity when the shared provider manifest validator changes', () => {
  const original = fileURLToPath(new URL('../../src/algorithm/', import.meta.url));
  const copy = mkdtempSync(join(tmpdir(), 'gear-kernel-identity-'));
  copies.push(copy);
  cpSync(original, copy, { recursive: true });
  expect(kernelImplementationDigest(copy)).toBe(kernelImplementationDigest());
  const validator = join(copy, 'runtime', 'provider-manifest.ts');
  writeFileSync(validator, `${readFileSync(validator, 'utf8')}\n// changed validator source\n`);
  expect(kernelImplementationDigest(copy)).not.toBe(kernelImplementationDigest());
});
