import { algorithm, workflow, type AuthorRoleResult, type AuthorTaskSelection } from '../../src/algorithm/author/index.js';

interface SearchConfig { taskCount: number; goal: string }

const archiveBranch = workflow(async (_ctx, role: AuthorRoleResult, selection: AuthorTaskSelection) =>
  ({ role, selection }), { name: 'archive-branch' });
const keepRole = workflow(async (_ctx, role: AuthorRoleResult) => role, { name: 'keep-role' });

/** Compiled by the repository typecheck as a standalone A1 author project example. */
export const sample = algorithm<SearchConfig>(async ctx => {
  const initialBindingDigest: string = ctx.initialAgent.bindingSetRef.digest;
  const count: number = ctx.config.taskCount;
  const role: AuthorRoleResult = await ctx.role('analyst', { goal: ctx.config.goal, initialBindingDigest });
  const selection = await ctx.tasks.sample({ kind: 'artifact', digest: 'b'.repeat(64), size: 1,
    mediaType: 'application/json', schemaId: 'task.view.v1' }, { count, seed: 7 });
  if (false) {
    // @ts-expect-error replay input is deeply read-only
    ctx.config.taskCount = count + 1;
    // @ts-expect-error the selected agent is deeply read-only
    ctx.initialAgent.bindingSetRef.digest = 'changed';
    // @ts-expect-error typed role output is deeply read-only
    role.output = null;
    // @ts-expect-error selected IDs are a readonly array
    selection.selectedTaskIds.push('new-task');
  }
  await ctx.checkpoint('proof', { role, selection });
  await ctx.operation('custom.archive', { role, selection });
  const branch = await archiveBranch(role, selection);
  const returnedRole = await keepRole(role);
  return ctx.result({ selected: ctx.initialAgent, outputs: { role: returnedRole, selection, branch, count } });
}, { configSchema: { type: 'object', required: ['taskCount', 'goal'], properties: {
  taskCount: { type: 'integer' }, goal: { type: 'string' },
}, additionalProperties: false } });
