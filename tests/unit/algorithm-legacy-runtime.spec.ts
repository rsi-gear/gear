import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { verifyPinnedLegacySearchClosure } from '../../src/algorithm/legacy-runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(!existsSync(resolve('.evolve-lab/algorithm-baselines/f715748/rsi-gear-0.1.0.tgz')))(
  'accepts the pinned f715748 search closure and rejects missing or changed old artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-legacy-package-')); roots.push(root);
  const tarball = resolve('.evolve-lab/algorithm-baselines/f715748/rsi-gear-0.1.0.tgz');
  const manifest = resolve('docs/algorithm-baselines/f715748/manifest.json');
  execFileSync('tar', ['-xzf', tarball, '-C', root]);
  const packageRoot = join(root, 'package');
  const verified = verifyPinnedLegacySearchClosure(packageRoot, manifest, tarball);
  expect(verified.searchIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(verified.parentPolicyIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);
  const policy = join(packageRoot, 'lib/search/policies/parents.js');
  const saved = await readFile(policy);
  await writeFile(policy, Buffer.concat([saved, Buffer.from('\n// drift\n')]));
  expect(() => verifyPinnedLegacySearchClosure(packageRoot, manifest, tarball)).toThrow('Legacy runtime artifact identity drift');
  await writeFile(policy, saved);
  await unlink(join(packageRoot, 'lib/search/identity.js'));
  expect(() => verifyPinnedLegacySearchClosure(packageRoot, manifest, tarball)).toThrow('Legacy runtime artifact missing');
});
