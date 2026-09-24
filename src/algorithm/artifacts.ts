import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArtifactRef, BindingSetRef } from './contracts.js';
import { assertJson, canonicalJson, type JsonValue } from './schema.js';

export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function assertDigest(digest: string): void { if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid content digest'); }
export function durableWrite(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

type StoredArtifact = { mediaType: string; schemaId?: string; data: string };
export class FileArtifactStore {
  constructor(readonly root: string, readonly maxBytes = 64 * 1024 * 1024) { mkdirSync(join(root, 'objects'), { recursive: true }); }

  putBytes(bytes: Uint8Array, mediaType: string, schemaId?: string): ArtifactRef {
    if (bytes.length > this.maxBytes) throw new Error('Artifact exceeds size limit');
    if (!mediaType || mediaType.includes('\0')) throw new Error('Invalid media type');
    const record: StoredArtifact = { mediaType, data: Buffer.from(bytes).toString('base64') };
    if (schemaId !== undefined) record.schemaId = schemaId;
    const serialized = canonicalJson(record);
    const digest = sha256(serialized);
    const path = join(this.root, 'objects', `${digest}.json`);
    if (!existsSync(path)) durableWrite(path, serialized);
    return schemaId === undefined
      ? { kind: 'artifact', digest, size: bytes.length, mediaType }
      : { kind: 'artifact', digest, size: bytes.length, mediaType, schemaId };
  }

  putJson(value: JsonValue, schemaId?: string): ArtifactRef { return this.putBytes(Buffer.from(canonicalJson(value)), 'application/json', schemaId); }

  getBytes(ref: ArtifactRef): Buffer {
    if (ref.kind !== 'artifact') throw new Error('Expected artifact reference');
    assertDigest(ref.digest);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > this.maxBytes) throw new Error('Invalid artifact size');
    const path = join(this.root, 'objects', `${ref.digest}.json`);
    if (statSync(path).size > this.maxBytes * 2 + 4096) throw new Error('Artifact record exceeds size limit');
    const raw = readFileSync(path, 'utf8');
    if (sha256(raw) !== ref.digest) throw new Error('Artifact digest mismatch');
    const stored = JSON.parse(raw) as StoredArtifact;
    if (stored.mediaType !== ref.mediaType || stored.schemaId !== ref.schemaId) throw new Error('Artifact metadata mismatch');
    const bytes = Buffer.from(stored.data, 'base64');
    if (bytes.length !== ref.size || bytes.length > this.maxBytes || bytes.toString('base64') !== stored.data) throw new Error('Artifact bytes mismatch');
    return bytes;
  }

  getJson(ref: ArtifactRef): JsonValue {
    if (ref.mediaType !== 'application/json') throw new Error('Artifact is not JSON');
    const value: unknown = JSON.parse(this.getBytes(ref).toString('utf8'));
    assertJson(value);
    return value;
  }

  getJsonByDigest(digest: string, schemaId?: string): JsonValue {
    assertDigest(digest);
    const path = join(this.root, 'objects', `${digest}.json`);
    if (statSync(path).size > this.maxBytes * 2 + 4096) throw new Error('Artifact record exceeds size limit');
    const raw = readFileSync(path, 'utf8');
    if (sha256(raw) !== digest) throw new Error('Artifact digest mismatch');
    const stored = JSON.parse(raw) as StoredArtifact;
    if (stored.mediaType !== 'application/json' || stored.schemaId !== schemaId) throw new Error('Artifact metadata mismatch');
    const bytes = Buffer.from(stored.data, 'base64');
    const ref: ArtifactRef = schemaId === undefined
      ? { kind: 'artifact', digest, size: bytes.length, mediaType: 'application/json' }
      : { kind: 'artifact', digest, size: bytes.length, mediaType: 'application/json', schemaId };
    return this.getJson(ref);
  }

  verifyContentRefs(value: JsonValue, bindings?: { read(ref: BindingSetRef): unknown }): void {
    const visit = (item: JsonValue): void => {
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (item === null || typeof item !== 'object') return;
      if (item.kind === 'artifact') { this.getBytes(item as ArtifactRef); return; }
      if (item.kind === 'binding-set') {
        if (!bindings) throw new Error('Binding reference without binding store');
        bindings.read(item as BindingSetRef); return;
      }
      Object.values(item).forEach(visit);
    };
    visit(value);
  }
}
