#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export async function inspect(directory) {
  const provenance = JSON.parse(await readFile(path.join(directory, 'provenance.json'), 'utf8'));
  for (const [file, expected] of Object.entries(provenance.files)) {
    const bytes = await readFile(path.join(directory, file));
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected) throw new Error(`Changed example artifact: ${file}`);
  }
  const manifest = JSON.parse(await readFile(path.join(directory, 'harness/manifest.json'), 'utf8'));
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(path.join(directory, 'harness', artifact.path));
    if (bytes.length !== artifact.bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) throw new Error(`Manifest mismatch: ${artifact.path}`);
  }
  return { sourceCommit: provenance.sourceCommit, verifiedArtifacts: manifest.artifacts.length, manifestDigest: manifest.digest, independentHeldOut: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('.', import.meta.url));
  console.log(JSON.stringify(await inspect(directory), null, 2));
}
