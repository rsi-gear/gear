import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

const F715748_MANIFEST_SHA256 = '99c98affe61ed1a3cee9e011c8fba94f522b6c1537366a9b463d593ddf2b71bc';
type RecordedFile = { path: string; bytes: number; sha256: string };
type LegacyManifest = { package: RecordedFile; builtSearch: { integrity: string; files: RecordedFile[] };
  builtParentPolicy: { integrity: string; files: RecordedFile[] };
  packageTarball: RecordedFile };

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function boundedPath(root: string, relative: string): string {
  const path = normalize(relative);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) || path.includes(`${sep}..${sep}`))
    throw new Error('Legacy manifest path escapes package');
  const resolved = resolve(root, path);
  if (!resolved.startsWith(resolve(root) + sep)) throw new Error('Legacy manifest path escapes package');
  return resolved;
}
function sameFile(path: string, file: RecordedFile): void {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { throw new Error(`Legacy runtime artifact missing: ${file.path}`); }
  if (bytes.length !== file.bytes || `sha256:${hash(bytes)}` !== file.sha256)
    throw new Error(`Legacy runtime artifact identity drift: ${file.path}`);
}

/** Check the archived search/parent closure; this is not a whole CLI/environment attestation. */
export function verifyPinnedLegacySearchClosure(packageRoot: string, manifestPath: string,
  tarballPath: string): { searchIntegrity: string; parentPolicyIntegrity: string } {
  const manifestBytes = readFileSync(manifestPath);
  if (hash(manifestBytes) !== F715748_MANIFEST_SHA256) throw new Error('Legacy baseline manifest identity drift');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as LegacyManifest;
  if (manifest.package.path !== 'package.json' || !Array.isArray(manifest.builtSearch.files)
    || !Array.isArray(manifest.builtParentPolicy.files) || !/^sha256:[a-f0-9]{64}$/u.test(manifest.builtSearch.integrity)
    || !/^sha256:[a-f0-9]{64}$/u.test(manifest.builtParentPolicy.integrity)) throw new Error('Legacy baseline manifest invalid');
  const files = new Map<string, RecordedFile>();
  for (const file of [manifest.package, ...manifest.builtSearch.files, ...manifest.builtParentPolicy.files]) {
    const prior = files.get(file.path);
    if (prior && (prior.bytes !== file.bytes || prior.sha256 !== file.sha256)) throw new Error('Conflicting legacy manifest file identity');
    files.set(file.path, file);
  }
  for (const file of files.values()) sameFile(boundedPath(packageRoot, file.path), file);
  sameFile(tarballPath, manifest.packageTarball);
  return { searchIntegrity: manifest.builtSearch.integrity, parentPolicyIntegrity: manifest.builtParentPolicy.integrity };
}
