import type { ArtifactRef, BindingSetRef } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { type JsonValue } from '../schema.js';

const linkedSchemas = new Set(['author.archive.v1', 'author.output-entry.v1', 'author.outputs.v1', 'author.result.v1']);
/** Enumerate declared A0 output edges and verify the entire reachable graph. */
export function verifyAuthorOutputGraph(artifacts: FileArtifactStore, bindings: BindingStore, value: JsonValue): void {
  const seen = new Set<string>();
  const visit = (node: JsonValue): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    if (node.kind === 'binding-set') { bindings.read(node as BindingSetRef); return; }
    if (node.kind === 'artifact') {
      const ref = node as ArtifactRef;
      if (ref.mediaType !== 'application/json' || !ref.schemaId || !linkedSchemas.has(ref.schemaId))
        throw new Error(`A0 output has undeclared artifact ref schema: ${ref.schemaId ?? ref.mediaType}`);
      const content = artifacts.getJson(ref); // validate every ref's own metadata, even for a repeated digest
      if (seen.has(ref.digest)) return;
      seen.add(ref.digest);
      visit(content);
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
}
