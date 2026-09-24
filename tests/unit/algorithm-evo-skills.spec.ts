import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { ArtifactRef, BindingSetRef, OperationEnvelope } from '../../src/algorithm/contracts.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { DshRoleSessionRegistry } from '../../src/algorithm/providers/roles.js';
import { createEvoSkillCapabilities } from '../../src/algorithm/providers/evo-skills.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function skill(name: string, text: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n\n${text}\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-evo-skills-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, { id: 'evo.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: false },
    skills: { schemaId: 'skills.library.v1', required: true, replaceable: true },
  } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
    commitOid: 'a'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}` }, 'harness.directory.v1');
  const alpha = artifacts.putJson({ schemaVersion: 1, markdown: skill('alpha', 'Alpha guidance.') }, 'skills.body.v1');
  const beta = artifacts.putJson({ schemaVersion: 1, markdown: skill('beta', 'Beta guidance.') }, 'skills.body.v1');
  const library = artifacts.putJson({ schemaVersion: 1, skills: [
    { name: 'alpha', contentRef: alpha }, { name: 'beta', contentRef: beta },
  ] }, 'skills.library.v1');
  const bindingSetRef = bindings.create({ harness, skills: library });
  let policyDigest = sha256('authorized-synthetic-destination');
  const allowed: string[] = [];
  const capabilities = createEvoSkillCapabilities({ artifacts, bindings, disclosure: {
    policyDigest, currentPolicyDigest: () => policyDigest,
    authorize(request) {
      if (request.campaignId !== 'synthetic-campaign' || !request.roleId.startsWith('evo.')) {
        throw new Error('Host denied Skill disclosure');
      }
      allowed.push(`${request.roleId}:${request.action}`);
    },
  } });
  function envelope(roleId: 'evo.retriever' | 'evo.proposer' | 'evo.curator', input: object = {},
    boundRef: BindingSetRef = bindingSetRef): OperationEnvelope {
    const operationId = sha256(`operation-${roleId}-${jsonDigest(input)}-${boundRef.digest}`);
    const body = { roleId, skillsBindingSetRef: boundRef,
      ...(roleId === 'evo.curator' ? { proposals: [{ action: 'NEW' }], batchTaskIds: ['task-1'] } : {}), ...input };
    return { operationId, idempotencyKey: operationId, campaignId: 'synthetic-campaign',
      decisionIndex: 0, localKey: roleId, kind: 'execution.role', input: body,
      inputDigest: jsonDigest(body), implementationDigest: sha256('host-role-port'),
      bindingSetRef: boundRef, limits: { 'evidence.items': 10, 'evidence.bytes': 50_000 } };
  }
  return { root, artifacts, bindings, harness, alpha, beta, library, bindingSetRef, capabilities,
    envelope, allowed, changePolicy: () => { policyDigest = sha256('changed-destination'); } };
}

describe('host-authorized bound Evo Skill capabilities (synthetic only)', () => {
  it('lists and reads only bound members after an explicit host disclosure grant, with durable usage', async () => {
    const f = await fixture();
    const envelope = f.envelope('evo.retriever', { injectionBudget: 2 });
    const sessions = new DshRoleSessionRegistry();
    sessions.configureUsageRoot(join(f.root, 'usage'), ['evidence.items', 'evidence.bytes']);
    sessions.bind('session-1', 'evo.retriever', envelope);
    const registered = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
    const agentCtx = { tools: { register(tool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) {
      registered.set(tool.name, tool);
    } } } as unknown as Context;
    f.capabilities.mount(agentCtx, 'session-1', sessions);
    const call = { agent: { id: 'session-1' } };
    const page = await registered.get('skills_list')!.execute({}, call) as { skills: Array<{ name: string; contentRef: ArtifactRef }> };
    expect(page.skills.map(item => item.name)).toEqual(['alpha', 'beta']);
    const read: { name: string; markdown: string } = await registered.get('skills_read')!.execute(
      { requestJson: JSON.stringify({ contentRef: f.beta }) }, call) as { name: string; markdown: string };
    expect(read.name).toBe('beta');
    expect(read.markdown).toContain('Beta guidance.');
    expect(f.allowed).toEqual(['evo.retriever:skills_list', 'evo.retriever:skills_read']);
    expect(sessions.usage(envelope)).toMatchObject({ returnedItems: 3, requests: 2 });
    const unrelated = f.artifacts.putJson({ schemaVersion: 1, markdown: skill('gamma', 'Outside.') }, 'skills.body.v1');
    await expect(registered.get('skills_read')!.execute({ requestJson: JSON.stringify({ contentRef: unrelated }) }, call))
      .rejects.toThrow(/not in the bound library/);
    expect(sessions.usage(envelope).requests).toBe(2);
    f.changePolicy();
    await expect(registered.get('skills_list')!.execute({}, call)).rejects.toThrow(/policy identity drift/);
  });

  it('validates retriever refs against exact bound members and injection budget', async () => {
    const f = await fixture();
    const envelope = f.envelope('evo.retriever', { injectionBudget: 1 });
    await expect(f.capabilities.publisher.publish('evo.retriever', { skillRefs: [f.beta] }, envelope))
      .resolves.toBeUndefined();
    await expect(f.capabilities.publisher.publish('evo.retriever', { skillRefs: [f.alpha, f.beta] }, envelope))
      .rejects.toThrow(/budget/);
    const unrelated = f.artifacts.putJson({ schemaVersion: 1, markdown: skill('gamma', 'Outside.') }, 'skills.body.v1');
    await expect(f.capabilities.publisher.publish('evo.retriever', { skillRefs: [unrelated] }, envelope))
      .rejects.toThrow(/unbound/);
    await expect(f.capabilities.publisher.publish('evo.retriever', { skillRefs: [f.alpha, f.alpha] },
      f.envelope('evo.retriever', { injectionBudget: 2 }))).rejects.toThrow(/repeated/);
  });

  it('blocks hard evidence delivery before tool output and refuses a mismatched bound session role', async () => {
    const f = await fixture();
    const base = f.envelope('evo.retriever', { injectionBudget: 2 });
    const envelope = { ...base, limits: { 'evidence.items': 1, 'evidence.bytes': 50_000 } };
    const sessions = new DshRoleSessionRegistry();
    sessions.configureUsageRoot(join(f.root, 'usage-hard'), ['evidence.items', 'evidence.bytes']);
    sessions.bind('session-hard', 'evo.retriever', envelope);
    const registered = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
    const agentCtx = { tools: { register(tool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) {
      registered.set(tool.name, tool);
    } } } as unknown as Context;
    f.capabilities.mount(agentCtx, 'session-hard', sessions);
    await expect(registered.get('skills_list')!.execute({}, { agent: { id: 'session-hard' } }))
      .rejects.toThrow(/hard evidence.items delivery limit/);
    expect(sessions.usage(envelope).returnedItems).toBe(0);
    sessions.bind('session-wrong', 'evo.curator', envelope);
    expect(() => f.capabilities.mount(agentCtx, 'session-wrong', sessions)).toThrow(/session role identity mismatch/);
  });

  it('seals ADD, REVISE, MERGE and SKIP while preserving unaffected inherited refs in sorted order', async () => {
    const f = await fixture();
    const base = f.envelope('evo.curator');
    const added = await f.capabilities.publisher.publish('evo.curator', { action: 'ADD',
      skills: [{ name: 'gamma', markdown: skill('gamma', 'New guidance.') }] }, base);
    expect(added?.schemaId).toBe('skills.library.v1');
    const afterAdd = f.artifacts.getJson(added!) as { skills: Array<{ name: string; contentRef: ArtifactRef }> };
    expect(afterAdd.skills.map(item => item.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(afterAdd.skills[0]!.contentRef).toEqual(f.alpha);
    expect(afterAdd.skills[1]!.contentRef).toEqual(f.beta);
    const addBinding = f.bindings.derive(f.bindingSetRef, { skills: added! });
    const revised = await f.capabilities.publisher.publish('evo.curator', { action: 'REVISE',
      skills: [{ name: 'beta', markdown: skill('beta', 'Revised guidance.') }] },
    f.envelope('evo.curator', {}, addBinding));
    const afterRevise = f.artifacts.getJson(revised!) as { skills: Array<{ name: string; contentRef: ArtifactRef }> };
    expect(afterRevise.skills[0]!.contentRef).toEqual(f.alpha);
    expect(afterRevise.skills[1]!.contentRef).not.toEqual(f.beta);
    expect(afterRevise.skills[2]!.contentRef).toEqual(afterAdd.skills[2]!.contentRef);
    const revisedBinding = f.bindings.derive(addBinding, { skills: revised! });
    const merged = await f.capabilities.publisher.publish('evo.curator', { action: 'MERGE',
      skills: [{ name: 'alpha', markdown: skill('alpha', 'Merged alpha and beta.'),
        sourceNames: ['alpha', 'beta'] }] }, f.envelope('evo.curator', {}, revisedBinding));
    const afterMerge = f.artifacts.getJson(merged!) as { skills: Array<{ name: string; contentRef: ArtifactRef }> };
    expect(afterMerge.skills.map(item => item.name)).toEqual(['alpha', 'gamma']);
    expect(afterMerge.skills[1]!.contentRef).toEqual(afterRevise.skills[2]!.contentRef);
    expect(await f.capabilities.publisher.publish('evo.curator', { action: 'SKIP' }, base)).toBeUndefined();
  });

  it('rejects invalid curator actions, nonmembers, duplicate names and malformed Skill bodies', async () => {
    const f = await fixture();
    const envelope = f.envelope('evo.curator');
    await expect(f.capabilities.publisher.publish('evo.curator', { action: 'ADD',
      skills: [{ name: 'alpha', markdown: skill('alpha', 'Overwrite.') }] }, envelope)).rejects.toThrow(/overwrite/);
    await expect(f.capabilities.publisher.publish('evo.curator', { action: 'REVISE',
      skills: [{ name: 'gamma', markdown: skill('gamma', 'Not bound.') }] }, envelope)).rejects.toThrow(/changed bound/);
    await expect(f.capabilities.publisher.publish('evo.curator', { action: 'MERGE',
      skills: [{ name: 'gamma', markdown: skill('gamma', 'Merge.'), sourceNames: ['beta', 'alpha'] }] }, envelope))
      .rejects.toThrow(/sorted source/);
    await expect(f.capabilities.publisher.publish('evo.curator', { action: 'ADD',
      skills: [{ name: 'gamma', markdown: skill('different', 'Invalid.') }] }, envelope))
      .rejects.toThrow(/frontmatter/);
    await expect(f.capabilities.publisher.publish('evo.curator', { action: 'SKIP',
      skills: [{ name: 'gamma', markdown: skill('gamma', 'Invalid.') }] }, envelope))
      .rejects.toThrow(/SKIP/);
  });
});
