import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { load as loadYaml } from 'js-yaml';
import type { ArtifactRef, BindingSetRef, OperationEnvelope } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { canonicalJson, type JsonValue } from '../schema.js';
import { implementationClosureDigest } from '../data/identity.js';
import { validateSkillOverlaySelection, type SkillsLibrary } from './skill-overlay.js';
import { RoleOutputValidationError, type DshRoleSessionRegistry, type RoleArtifactPublisher } from './roles.js';

type EvoRoleId = 'evo.retriever' | 'evo.proposer' | 'evo.curator';
type SkillEntry = SkillsLibrary['skills'][number];
type BoundLibrary = { ref: ArtifactRef; entries: SkillEntry[]; baseHarness: { commitOid: string; manifestDigest: string } };
type DisclosureAction = 'skills_list' | 'skills_read';
export type EvoSkillDisclosureGrant = {
  /** Host-issued identity of the destination and authorization policy; never chosen by a recipe. */
  policyDigest: string;
  currentPolicyDigest(): string;
  authorize(request: { campaignId: string; operationId: string; roleId: EvoRoleId;
    action: DisclosureAction; contentRef?: ArtifactRef }): Promise<void> | void;
};
export type EvoSkillCapabilityOptions = {
  artifacts: FileArtifactStore;
  bindings: BindingStore;
  disclosure: EvoSkillDisclosureGrant;
  maxSkills?: number;
  maxToolRequests?: number;
};
export type EvoSkillCapabilities = {
  implementationDigest: string;
  publisher: RoleArtifactPublisher;
  mount(agentCtx: Context, sessionId: string, sessions: DshRoleSessionRegistry): void;
};

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ROLES: readonly EvoRoleId[] = ['evo.retriever', 'evo.proposer', 'evo.curator'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Evo Skill object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...expected, ...optional]);
  if (actual.some(key => !allowed.has(key)) || expected.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Unexpected Evo Skill fields');
  }
}
function ref(value: unknown, schemaId?: string): ArtifactRef {
  const item = object(value) as Partial<ArtifactRef>;
  if (item.kind !== 'artifact' || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.digest)
    || !Number.isSafeInteger(item.size) || (item.size ?? -1) < 0 || item.mediaType !== 'application/json'
    || schemaId !== undefined && item.schemaId !== schemaId) throw new Error('Invalid Evo Skill artifact reference');
  return item as ArtifactRef;
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue); }
function role(envelope: OperationEnvelope): EvoRoleId {
  if (envelope.kind !== 'execution.role') throw new Error('Evo Skill capability requires a role operation');
  const selected = object(envelope.input).roleId;
  if (typeof selected !== 'string' || !ROLES.includes(selected as EvoRoleId)) throw new Error('Not an Evo Skill role');
  return selected as EvoRoleId;
}
function bound(options: EvoSkillCapabilityOptions, envelope: OperationEnvelope, maxSkills: number): BoundLibrary {
  const input = object(envelope.input);
  const selectedRole = role(envelope);
  const declared = input.skillsBindingSetRef;
  if (selectedRole !== 'evo.proposer' && !same(declared, envelope.bindingSetRef)) {
    throw new Error('Evo Skill role did not name its exact bound version');
  }
  if (selectedRole === 'evo.proposer' && declared !== undefined && !same(declared, envelope.bindingSetRef)) {
    throw new Error('Evo proposer Skill binding version drift');
  }
  const slots = options.bindings.read(envelope.bindingSetRef).slots;
  if (Object.keys(slots).sort().join('\0') !== 'harness\0skills') throw new Error('Evo Skill tools need exact harness/skills bindings');
  const harness = object(options.artifacts.getJson(ref(slots.harness, 'harness.directory.v1')));
  if (harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
    || typeof harness.commitOid !== 'string' || !/^[a-f0-9]{40}$/u.test(harness.commitOid)
    || typeof harness.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(harness.manifestDigest)) {
    throw new Error('Invalid Evo bound Git harness');
  }
  const libraryRef = ref(slots.skills, 'skills.library.v1');
  const library = options.artifacts.getJson(libraryRef) as unknown as SkillsLibrary;
  if (!library || library.schemaVersion !== 1 || !Array.isArray(library.skills)
    || library.skills.length > maxSkills) throw new Error('Evo bound Skill library exceeds limit');
  validateSkillOverlaySelection({ baseHarness: { commitOid: harness.commitOid, manifestDigest: harness.manifestDigest },
    bindingSetRef: envelope.bindingSetRef, skillsLibraryRef: libraryRef,
    selectedSkillRefs: library.skills.map(item => item.contentRef),
    artifacts: options.artifacts, bindings: options.bindings });
  return { ref: libraryRef, entries: library.skills,
    baseHarness: { commitOid: harness.commitOid, manifestDigest: harness.manifestDigest } };
}
function markdown(name: string, value: unknown): string {
  if (!NAME.test(name) || typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024
    || value.includes('\0') || !value.startsWith('---\n')) throw new Error('Invalid Evo Skill name or body');
  const end = value.indexOf('\n---\n', 4);
  if (end < 0 || end > 32 * 1024) throw new Error('Evo Skill frontmatter missing or too large');
  const parsed: unknown = loadYaml(value.slice(4, end));
  const header = object(parsed);
  if (header.name !== name || typeof header.description !== 'string' || !header.description.trim()) {
    throw new Error('Evo Skill frontmatter name/description mismatch');
  }
  return value;
}
function invalidOutput(message: string): never {
  throw new RoleOutputValidationError('dsh_role_publisher_validation', message);
}
function outputObject(value: unknown): Record<string, unknown> {
  try { return object(value); } catch { return invalidOutput('Invalid Evo Skill role output object'); }
}
function outputKeys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): void {
  try { keys(value, expected, optional); } catch { invalidOutput('Unexpected Evo Skill role output fields'); }
}
function outputRef(value: unknown, schemaId: string): ArtifactRef {
  try { return ref(value, schemaId); } catch { return invalidOutput('Invalid Evo Skill role output reference'); }
}
function outputMarkdown(name: string, value: unknown): string {
  try { return markdown(name, value); } catch { return invalidOutput('Invalid Evo Skill frontmatter or Markdown'); }
}

/** Does not reveal a bound library until the host verifies role and model destination for this call. */
export function createEvoSkillCapabilities(options: EvoSkillCapabilityOptions): EvoSkillCapabilities {
  options = Object.freeze({ ...options,
    disclosure: Object.freeze({ ...options.disclosure }) });
  assertDigest(options.disclosure.policyDigest);
  const policyDigest = options.disclosure.policyDigest;
  const maxSkills = options.maxSkills ?? 128, maxToolRequests = options.maxToolRequests ?? 100;
  if (!Number.isSafeInteger(maxSkills) || maxSkills < 1 || maxSkills > 128
    || !Number.isSafeInteger(maxToolRequests) || maxToolRequests < 1 || maxToolRequests > 1_000) {
    throw new Error('Invalid Evo Skill capability limits');
  }
  const implementationDigest = implementationClosureDigest(['providers/evo-skills'],
    { policyDigest, maxSkills, maxToolRequests });
  const requirePolicy = (): void => {
    if (options.disclosure.currentPolicyDigest() !== policyDigest) throw new Error('Evo Skill disclosure policy identity drift');
  };
  const publisher: RoleArtifactPublisher = {
    implementationDigest,
    async publish(roleId, result, envelope) {
      requirePolicy();
      if (roleId !== role(envelope)) throw new Error('Evo Skill publisher role identity drift');
      const library = bound(options, envelope, maxSkills);
      const value = outputObject(result);
      if (roleId === 'evo.retriever') {
        outputKeys(value, ['skillRefs']);
        const requested = value.skillRefs;
        const budget = object(envelope.input).injectionBudget;
        if (!Array.isArray(requested) || !Number.isSafeInteger(budget) || (budget as number) < 0
          || requested.length > (budget as number)) invalidOutput('Evo retriever exceeded bound injection budget');
        const members = new Set(library.entries.map(item => canonicalJson(item.contentRef)));
        const selected = new Set<string>();
        for (const item of requested) {
          const key = canonicalJson(outputRef(item, 'skills.body.v1'));
          if (!members.has(key) || selected.has(key)) invalidOutput('Evo retriever chose an unbound or repeated Skill');
          selected.add(key);
        }
        return undefined;
      }
      if (roleId === 'evo.proposer') return undefined;
      if (roleId !== 'evo.curator') throw new Error('Unsupported Evo Skill publisher role');
      const sourceInput = object(envelope.input);
      if (!Array.isArray(sourceInput.proposals) || !Array.isArray(sourceInput.batchTaskIds)
        || sourceInput.batchTaskIds.length === 0
        || sourceInput.batchTaskIds.some(id => typeof id !== 'string' || !id)
        || new Set(sourceInput.batchTaskIds).size !== sourceInput.batchTaskIds.length) {
        throw new Error('Evo curator has no frozen proposal batch');
      }
      outputKeys(value, ['action'], ['skills']);
      const action = value.action;
      if (!['ADD', 'MERGE', 'REVISE', 'SKIP'].includes(String(action))) invalidOutput('Invalid Evo curator action');
      if (action === 'SKIP') {
        if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length !== 0)) {
          invalidOutput('Evo curator SKIP cannot publish Skills');
        }
        return undefined;
      }
      if (sourceInput.proposals.length === 0) throw new Error('Evo curator cannot publish without proposals');
      if (!Array.isArray(value.skills) || value.skills.length < 1 || value.skills.length > 32) {
        invalidOutput('Evo curator needs bounded Skill changes');
      }
      const existing = new Map(library.entries.map(item => [item.name, item.contentRef]));
      const next = new Map(existing);
      const changed = new Set<string>(), mergedSources = new Set<string>();
      const prepared: Array<{ name: string; markdown: string; sourceNames: string[] }> = [];
      for (const raw of value.skills) {
        const item = outputObject(raw);
        outputKeys(item, ['name', 'markdown'], action === 'MERGE' ? ['sourceNames'] : []);
        if (typeof item.name !== 'string' || changed.has(item.name)) invalidOutput('Duplicate or invalid Evo curated Skill name');
        changed.add(item.name);
        const body = outputMarkdown(item.name, item.markdown);
        let sourceNames: string[] = [];
        if (action === 'ADD') {
          if (existing.has(item.name)) invalidOutput('Evo ADD cannot overwrite an existing Skill');
        } else if (action === 'REVISE') {
          const previous = existing.get(item.name);
          if (!previous || (options.artifacts.getJson(previous) as { markdown: string }).markdown === body) {
            invalidOutput('Evo REVISE requires a changed bound Skill');
          }
        } else {
          if (!Array.isArray(item.sourceNames) || item.sourceNames.length < 2
            || item.sourceNames.some(name => typeof name !== 'string')
            || new Set(item.sourceNames).size !== item.sourceNames.length
            || [...item.sourceNames].sort().join('\0') !== item.sourceNames.join('\0')) {
            invalidOutput('Evo MERGE needs distinct sorted source names');
          }
          sourceNames = item.sourceNames as string[];
          if (existing.has(item.name) && !sourceNames.includes(item.name)) {
            invalidOutput('Evo MERGE target would overwrite an unrelated Skill');
          }
          for (const name of sourceNames) {
            if (!existing.has(name) || mergedSources.has(name)) invalidOutput('Evo MERGE source is absent or reused');
            mergedSources.add(name);
          }
        }
        prepared.push({ name: item.name, markdown: body, sourceNames });
      }
      const projectedNames = new Set(existing.keys());
      if (action === 'MERGE') for (const source of mergedSources) projectedNames.delete(source);
      for (const item of prepared) projectedNames.add(item.name);
      if (projectedNames.size > maxSkills) invalidOutput('Evo curated library exceeds host limit');
      if (action === 'MERGE') for (const source of mergedSources) next.delete(source);
      for (const item of prepared) {
        const bodyRef = options.artifacts.putJson({ schemaVersion: 1, markdown: item.markdown }, 'skills.body.v1');
        next.set(item.name, bodyRef);
      }
      const sealed: SkillsLibrary = { schemaVersion: 1,
        skills: [...next].sort(([a], [b]) => a.localeCompare(b)).map(([name, contentRef]) => ({ name, contentRef })) };
      return options.artifacts.putJson(sealed as unknown as JsonValue, 'skills.library.v1');
    },
  };
  return {
    implementationDigest, publisher,
    mount(agentCtx, sessionId, sessions) {
      const envelope = sessions.envelope(sessionId);
      const selectedRole = role(envelope);
      if (sessions.require(sessionId) !== selectedRole) throw new Error('Evo Skill session role identity mismatch');
      let requests = 0;
      const invoke = async (action: DisclosureAction, contentRef?: ArtifactRef): Promise<BoundLibrary> => {
        if (++requests > maxToolRequests) throw new Error('Evo Skill tool request cap exceeded');
        requirePolicy();
        await options.disclosure.authorize({ campaignId: envelope.campaignId, operationId: envelope.operationId,
          roleId: selectedRole, action, ...(contentRef ? { contentRef } : {}) });
        return bound(options, envelope, maxSkills);
      };
      const output = { schema: { type: 'json' as const }, render(_args: unknown, value: JsonValue) {
        return [{ type: 'text' as const, text: canonicalJson(value) }];
      } };
      agentCtx.tools.register(defineTool({ name: 'skills_list',
        description: 'List names and refs from the exact host-authorized bound Skill library.',
        parameters: {}, output,
        async execute(_args, exec) {
          if (String(exec.agent?.id) !== sessionId) throw new Error('Evo Skill tool session identity mismatch');
          const library = await invoke('skills_list');
          const page = { skills: library.entries.map(item => ({ name: item.name, contentRef: item.contentRef })) };
          sessions.account(sessionId, { returnedItems: page.skills.length,
            returnedBytes: Buffer.byteLength(canonicalJson(page)), requests: 1 });
          return page as JsonValue;
        },
      }));
      agentCtx.tools.register(defineTool({ name: 'skills_read',
        description: 'Read one exact member of the host-authorized bound Skill library.',
        parameters: { requestJson: { type: 'string', required: true } }, output,
        async execute(args, exec) {
          if (String(exec.agent?.id) !== sessionId) throw new Error('Evo Skill tool session identity mismatch');
          if (Buffer.byteLength(args.requestJson) > 16 * 1024) throw new Error('Evo Skill read request too large');
          const request = object(JSON.parse(args.requestJson) as unknown);
          keys(request, ['contentRef']);
          const requested = ref(request.contentRef, 'skills.body.v1');
          const library = await invoke('skills_read', requested);
          const member = library.entries.find(item => same(item.contentRef, requested));
          if (!member) throw new Error('Evo Skill read denied: ref is not in the bound library');
          const body = object(options.artifacts.getJson(member.contentRef));
          const result = { name: member.name, markdown: markdown(member.name, body.markdown) };
          sessions.account(sessionId, { returnedItems: 1,
            returnedBytes: Buffer.byteLength(canonicalJson(result)), requests: 1 });
          return result as JsonValue;
        },
      }));
    },
  };
}
