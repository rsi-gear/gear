import { readFileSync } from 'node:fs';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { expect, it } from 'vitest';
import { assertAuthorCapabilitiesV1, assertHarnessAgentV1, assertTaskSelectionV1,
  assertProposalBatchV1, assertEvaluationV1 } from '../../src/algorithm/author/a1-contract.js';
import { decodeRoleExecutionResult } from '../../src/algorithm/author/a1-contract.js';
import type { JsonValue } from '../../src/algorithm/schema.js';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/author-a1-dto-vectors.json', import.meta.url), 'utf8')) as
  { name: string; validator: string; value: unknown; valid: boolean }[];
const validate = {
  harnessAgent: assertHarnessAgentV1, capabilities: assertAuthorCapabilitiesV1,
  taskSelection: assertTaskSelectionV1, proposalBatch: assertProposalBatchV1,
  evaluation: assertEvaluationV1, roleExecution: (value: unknown) => decodeRoleExecutionResult(value, 'c'.repeat(64)),
};

it.each(vectors)('shares A1 DTO validation vector $name', row => {
  const check = validate[row.validator as keyof typeof validate];
  expect(check).toBeDefined();
  if (row.valid) expect(() => check(row.value)).not.toThrow();
  else expect(() => check(row.value)).toThrow();
});
