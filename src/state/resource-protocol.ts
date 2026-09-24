// Public hitch-resource-lock@1 contract. Validate changes against test-contracts/hitch-resources-v1.json.
import { createHash } from "node:crypto";
type Sha256 = `sha256:${string}`;

export type Resource =
  | { kind: "blob"; digest: Sha256; size: number }
  | { kind: "tree"; format: "hitch-tree@1"; manifestDigest: Sha256 }
  | { kind: "oci-image"; manifestDigest: Sha256; platform: string; indexDigest?: Sha256 };
export type Consumer = { role: "candidate" } | { role: "verifier" } | { role: "service"; serviceId: string };
export type Binding = { resource: string; consumer: Consumer } & (
  | { use: "input-file"; target: string; executable: boolean; access: "read-only" | "private-copy" }
  | { use: "input-tree"; target: string; access: "read-only" | "private-copy" }
  | { use: "environment-image"; slot: "runtime" | "build-base" }
);
export interface TaskResourceLock {
  protocol: "hitch-resource-lock@1";
  resources: Record<string, Resource>;
  bindings: Binding[];
  requiredCapabilities: string[];
}
export type TreeEntry = { path: string; kind: "directory" } | { path: string; kind: "file"; digest: Sha256; size: number; executable: boolean };
export interface TreeManifest { protocol: "hitch-tree@1"; entries: TreeEntry[] }
export const RESOURCE_CAPABILITIES = ["blob@1", "tree@1", "oci-image@1", "input-file@1", "input-tree@1", "environment-image@1", "private-copy@1", "read-only@1"] as const;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-canonical JSON value");
  return result;
}
export function hash(bytes: string | Uint8Array): Sha256 { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
export function identity(domain: string, value: unknown): Sha256 { return hash(canonical({ protocol: domain, value })); }
export function compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("resource record must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new TypeError("unknown resource field");
  return result;
}
export function sha(value: unknown): Sha256 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("invalid resource SHA-256");
  return value as Sha256;
}
export function natural(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("resource size must be a non-negative safe integer");
  return value as number;
}
export function resourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "." || value === "..") throw new TypeError("invalid resource ID");
  return value;
}
export function portablePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.normalize("NFC") !== value
    || /[\\\x00-\x1f\x7f:]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new TypeError("non-portable resource path");
  return value;
}
export function parseResource(value: unknown): Resource {
  const raw = object(value, ["kind", "digest", "size", "format", "manifestDigest", "platform", "indexDigest"]);
  if (raw.kind === "blob") {
    object(raw, ["kind", "digest", "size"]);
    return { kind: "blob", digest: sha(raw.digest), size: natural(raw.size) };
  }
  if (raw.kind === "tree") {
    object(raw, ["kind", "format", "manifestDigest"]);
    if (raw.format !== "hitch-tree@1") throw new TypeError("unsupported resource tree format");
    return { kind: "tree", format: raw.format, manifestDigest: sha(raw.manifestDigest) };
  }
  if (raw.kind === "oci-image") {
    object(raw, ["kind", "manifestDigest", "platform", "indexDigest"]);
    if (typeof raw.platform !== "string" || !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(raw.platform)) throw new TypeError("unsupported OCI platform");
    return { kind: "oci-image", manifestDigest: sha(raw.manifestDigest), platform: raw.platform,
      ...(raw.indexDigest === undefined ? {} : { indexDigest: sha(raw.indexDigest) }) };
  }
  throw new TypeError("unsupported resource kind");
}
export function parseResourceLock(value: unknown): TaskResourceLock {
  const raw = object(value, ["protocol", "resources", "bindings", "requiredCapabilities"]);
  if (raw.protocol !== "hitch-resource-lock@1") throw new TypeError("unsupported resource lock protocol");
  if (!raw.resources || typeof raw.resources !== "object" || Array.isArray(raw.resources)) throw new TypeError("resources must be a map");
  const resources = Object.fromEntries(Object.entries(raw.resources).sort(([a], [b]) => compare(a, b)).map(([id, resource]) => [resourceId(id), parseResource(resource)]));
  if (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.some(c => typeof c !== "string" || !/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(c))
    || new Set(raw.requiredCapabilities).size !== raw.requiredCapabilities.length) throw new TypeError("invalid required resource capabilities");
  if (!Array.isArray(raw.bindings)) throw new TypeError("resource bindings must be an array");
  const bindings = raw.bindings.map(value => {
    const binding = object(value, ["resource", "consumer", "use", "target", "executable", "access", "slot"]);
    const resource = resourceId(binding.resource), dependency = resources[resource];
    if (!dependency) throw new TypeError("binding refers to missing resource");
    const role = object(binding.consumer, ["role", "serviceId"]);
    let consumer: Consumer;
    if (role.role === "service") consumer = { role: "service", serviceId: portablePath(resourceId(role.serviceId)) };
    else if ((role.role === "candidate" || role.role === "verifier") && role.serviceId === undefined) consumer = { role: role.role };
    else throw new TypeError("invalid resource consumer");
    if (consumer.role === "service" && consumer.serviceId.toLowerCase() === "main") throw new TypeError("main is reserved for the candidate role");
    if (binding.use === "environment-image") {
      object(binding, ["resource", "consumer", "use", "slot"]);
      if (dependency.kind !== "oci-image" || binding.slot !== "runtime" && binding.slot !== "build-base") throw new TypeError("invalid environment image binding");
      return { resource, consumer, use: binding.use, slot: binding.slot } as Binding;
    }
    object(binding, ["resource", "consumer", "use", "target", "executable", "access"]);
    const target = portablePath(binding.target), access = binding.access;
    if (access !== "read-only" && access !== "private-copy") throw new TypeError("invalid resource access");
    if (binding.use === "input-file" && dependency.kind === "blob" && typeof binding.executable === "boolean") return { resource, consumer, use: binding.use, target, access, executable: binding.executable } as Binding;
    if (binding.use === "input-tree" && dependency.kind === "tree" && binding.executable === undefined) return { resource, consumer, use: binding.use, target, access } as Binding;
    throw new TypeError("resource kind and binding use disagree");
  });
  for (const [index, binding] of bindings.entries()) for (const other of bindings.slice(0, index)) {
    if (canonical(binding.consumer).toLowerCase() !== canonical(other.consumer).toLowerCase()) continue;
    if (binding.use === "environment-image" && other.use === "environment-image" && binding.slot === other.slot) throw new TypeError("duplicate environment slot");
    if (binding.use !== "environment-image" && other.use !== "environment-image") {
      const a = binding.target.toLocaleLowerCase("en-US"), b = other.target.toLocaleLowerCase("en-US");
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) throw new TypeError("conflicting resource paths");
    }
  }
  return { protocol: raw.protocol, resources, bindings, requiredCapabilities: [...raw.requiredCapabilities] as string[] };
}

export function parseTree(value: unknown): TreeManifest {
  const raw = object(value, ["protocol", "entries"]);
  if (raw.protocol !== "hitch-tree@1" || !Array.isArray(raw.entries)) throw new TypeError("unsupported tree manifest");
  const entries = raw.entries.map(value => {
    const entry = object(value, ["path", "kind", "digest", "size", "executable"]), name = portablePath(entry.path);
    if (entry.kind === "directory") { object(entry, ["path", "kind"]); return { path: name, kind: "directory" } as TreeEntry; }
    if (entry.kind !== "file" || typeof entry.executable !== "boolean") throw new TypeError("invalid tree entry");
    return { path: name, kind: "file", digest: sha(entry.digest), size: natural(entry.size), executable: entry.executable } as TreeEntry;
  });
  const paths = new Map<string, TreeEntry>();
  for (const [i, entry] of entries.entries()) {
    if (i && compare(entries[i - 1]!.path, entry.path) >= 0) throw new TypeError("tree paths must be unique and byte-sorted");
    const key = entry.path.toLocaleLowerCase("en-US");
    if (paths.has(key)) throw new TypeError("tree paths collide on a case-insensitive filesystem");
    paths.set(key, entry);
    const parts = entry.path.split("/"); parts.pop();
    if (parts.length && paths.get(parts.join("/").toLocaleLowerCase("en-US"))?.kind !== "directory") throw new TypeError("tree parent directory is missing");
  }
  return { protocol: raw.protocol, entries };
}

/** JSON.parse accepts duplicate keys. Lock/manifest text must reject them before
 * parsing so a repeated resource ID cannot silently replace its first value. */
export function parseStrictJson(text: string): unknown {
  let at = 0;
  const white = () => { while (/\s/u.test(text[at] ?? "") && at < text.length) at++; };
  const string = (): string => {
    white(); const start = at; if (text[at++] !== '"') throw new TypeError("invalid JSON key");
    while (at < text.length) { const c = text[at++]; if (c === "\\") at++; else if (c === '"') return JSON.parse(text.slice(start, at)) as string; }
    throw new TypeError("unterminated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new TypeError("resource JSON nesting limit exceeded");
    white(); const c = text[at];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      at++; white(); const close = c === "{" ? "}" : "]", keys = new Set<string>();
      if (text[at] === close) { at++; return; }
      for (;;) {
        if (c === "{") { const key = string(); if (keys.has(key)) throw new TypeError("duplicate JSON key"); keys.add(key); white(); if (text[at++] !== ":") throw new TypeError("invalid JSON"); }
        value(depth + 1); white(); const end = text[at++]; if (end === close) break; if (end !== ",") throw new TypeError("invalid JSON");
      }
      return;
    }
    const start = at; while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++; if (at === start) throw new TypeError("invalid JSON");
  };
  value(0); white(); if (at !== text.length) throw new TypeError("trailing JSON content");
  return JSON.parse(text) as unknown;
}
