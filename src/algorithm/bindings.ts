import type { ArtifactRef, BindingSchema, BindingSet, BindingSetRef } from './contracts.js';
import { ALGORITHM_API_VERSION } from './contracts.js';
import { FileArtifactStore } from './artifacts.js';
import { assertSafeKey, type JsonValue } from './schema.js';

export class BindingStore {
  constructor(readonly artifacts: FileArtifactStore, readonly schema: BindingSchema) {
    if (!schema.id) throw new Error('Binding schema requires id');
    for (const [name, slot] of Object.entries(schema.slots)) { assertSafeKey(name); if (!slot.schemaId) throw new Error(`Slot ${name} requires schemaId`); }
  }

  create(slots: Record<string, ArtifactRef>): BindingSetRef {
    const set: BindingSet = { apiVersion: ALGORITHM_API_VERSION, schemaId: this.schema.id, slots };
    this.validate(set);
    const ref = this.artifacts.putJson(set as unknown as JsonValue, `binding-set:${this.schema.id}`);
    return { kind: 'binding-set', digest: ref.digest, schemaId: this.schema.id };
  }

  read(ref: BindingSetRef): BindingSet {
    if (ref.kind !== 'binding-set' || ref.schemaId !== this.schema.id) throw new Error('Binding schema mismatch');
    const artifact: ArtifactRef = { kind: 'artifact', digest: ref.digest, size: 0, mediaType: 'application/json', schemaId: `binding-set:${this.schema.id}` };
    // The size is recovered from the content envelope, then checked by getJson.
    const set = this.artifacts.getJsonByDigest(artifact.digest, artifact.schemaId) as unknown as BindingSet;
    this.validate(set);
    return set;
  }

  derive(baseRef: BindingSetRef, replacements: Record<string, ArtifactRef>): BindingSetRef {
    const base = this.read(baseRef);
    const next: Record<string, ArtifactRef> = { ...base.slots };
    for (const [slot, ref] of Object.entries(replacements)) {
      assertSafeKey(slot);
      if (!this.schema.slots[slot]?.replaceable) throw new Error(`Slot ${slot} cannot be replaced`);
      next[slot] = ref;
    }
    return this.create(next);
  }

  validate(set: BindingSet): void {
    if (set.apiVersion !== ALGORITHM_API_VERSION || set.schemaId !== this.schema.id || !set.slots || typeof set.slots !== 'object' || Array.isArray(set.slots)) throw new Error('Invalid binding set');
    for (const [slot, ref] of Object.entries(set.slots)) {
      assertSafeKey(slot);
      const rule = this.schema.slots[slot];
      if (!rule) throw new Error(`Unknown binding slot ${slot}`);
      if (ref.schemaId !== rule.schemaId) throw new Error(`Binding slot ${slot} schema mismatch`);
      this.artifacts.getBytes(ref);
    }
    for (const [slot, rule] of Object.entries(this.schema.slots)) if (rule.required && !Object.hasOwn(set.slots, slot)) throw new Error(`Missing required binding ${slot}`);
  }
}
