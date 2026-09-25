import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assertSchema, validateSchema, type JsonSchema } from '../../src/algorithm/schema.js';
import { algorithm, AUTHOR_WIRE_VERSION_V2, replay, searchConfigSchema } from '../../src/algorithm/author/index.js';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/author-schema-bound-vectors.json', import.meta.url), 'utf8')) as
  { name: string; schema: JsonSchema; value: unknown; valid: boolean }[];
it.each(vectors)('shares schema-bound vector $name', row => {
  if (row.valid) expect(() => validateSchema(row.schema, row.value)).not.toThrow();
  else expect(() => { assertSchema(row.schema); validateSchema(row.schema, row.value); }).toThrow();
});
it('rejects nonpositive generated search config before the first effect', async () => {
  const definition = algorithm(async ctx => await ctx.operation('custom.effect', {}),
    { configSchema: searchConfigSchema });
  const input = { initialAgent: { schemaVersion: 1 as const, kind: 'harness-agent' as const,
    bindingSetRef: { kind: 'binding-set' as const, digest: 'a'.repeat(64), schemaId: 'binding.set.v1' },
    executionProfileDigest: 'b'.repeat(64) }, data: {},
  capabilities: { version: 'gear.author.capabilities.v1' as const, lockDigest: 'c'.repeat(64),
    roles: {}, operationLimits: {}, execution: {} } };
  const valid = await replay(definition, { version: AUTHOR_WIRE_VERSION_V2,
    input: { ...input, config: { rounds: 1, taskCount: 2, proposalCount: 1, seed: -1 } }, history: [] });
  expect(valid).toMatchObject({ status: 'waiting', frontier: [{ kind: 'custom.effect' }] });
  for (const config of [
    { rounds: 0, taskCount: 2, proposalCount: 1, seed: 0 },
    { rounds: 1, taskCount: -1, proposalCount: 1, seed: 0 },
    { rounds: 1, taskCount: 2, proposalCount: 0, seed: 0 },
    { rounds: 1, taskCount: 2, proposalCount: 1, seed: 9007199254740992 },
    { rounds: 1, taskCount: 2, proposalCount: 1, seed: 0, extra: true },
  ]) await expect(replay(definition, { version: AUTHOR_WIRE_VERSION_V2,
    input: { ...input, config }, history: [] })).rejects.toThrow();
});
