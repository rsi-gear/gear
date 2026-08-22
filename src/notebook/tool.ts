import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { NotebookRuntime } from './runtime.js'
import type { SessionRole } from '../types.js'

export function renderNotebookResult(stdout: string, stderr: string, result: string | null | undefined): string {
  return [stdout, stderr, result].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n') || '<no output>'
}

export function mountNotebookTool(
  agentCtx: Context,
  runtime: NotebookRuntime,
  role: SessionRole,
  fallbackCwd: string,
): void {
  agentCtx.systemPrompt.section({
    name: `tool:ipython-input:${role}`,
    order: 106,
    text: 'The IPython namespace persists for this session. Host APIs are role-scoped; an unavailable API fails instead of widening authority.',
  })
  agentCtx.tools.register(defineTool({
    name: 'ipython_input',
    description: 'Execute Python in this session\'s persistent IPython namespace.',
    parameters: {
      code: { type: 'string', required: true, description: 'Python/IPython code to execute.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          executionCount: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('ipython_input requires an agent session')
      const result = await runtime.execute({
        sessionId: String(exec.agent.id),
        cwd: exec.agent.session.header.cwd ?? fallbackCwd,
        role,
        code: args.code,
        signal: exec.signal,
      })
      if (result.concludesTurn === true) exec.concludeTurn()
      return { text: renderNotebookResult(result.stdout, result.stderr, result.result), executionCount: result.executionCount }
    },
  }))
}

export type MetaCapabilityCaller = (
  sessionId: string,
  method: string,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render(_args: unknown, value: JsonValue) {
    return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
  },
}

const ARTIFACT_OPERATION_SCHEMA = {
  oneOf: [
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'Create a new harness artifact. The path must not already exist.',
      properties: {
        type: { type: 'string' as const, const: 'create', required: true },
        path: { type: 'string' as const, required: true, description: 'Manifest-relative artifact path.' },
        content: { type: 'string' as const, required: true, description: 'Complete UTF-8 file content.' },
        expect: { type: 'string' as const, const: 'absent', required: true },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'Patch an existing harness artifact with a unified diff.',
      properties: {
        type: { type: 'string' as const, const: 'patch', required: true },
        path: { type: 'string' as const, required: true, description: 'Manifest-relative artifact path.' },
        patch: { type: 'string' as const, required: true, description: 'Unified diff that applies cleanly to the exact current file.' },
        expectedDigest: { type: 'string' as const, required: true, description: 'Exact sha256 digest returned by harness_read.' },
      },
    },
    {
      type: 'object' as const,
      additionalProperties: false,
      description: 'Delete an existing harness artifact.',
      properties: {
        type: { type: 'string' as const, const: 'delete', required: true },
        path: { type: 'string' as const, required: true, description: 'Manifest-relative artifact path.' },
        expectedDigest: { type: 'string' as const, required: true, description: 'Exact sha256 digest returned by harness_read.' },
      },
    },
  ] as const,
} as const

const HARNESS_MUTATION_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  description: 'A complete, current-round target harness mutation.',
  properties: {
    parentRef: { type: 'string' as const, required: true, description: 'Full champion Git commit from harness_current.' },
    parentDigest: { type: 'string' as const, required: true, description: 'Champion manifest digest from harness_current.' },
    target: {
      type: 'string' as const,
      enum: [
        'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
        'skill', 'tool', 'workflow', 'compaction',
      ] as const,
      required: true,
      description: 'Primary semantic surface changed by this mutation.',
    },
    ops: {
      type: 'array' as const,
      items: ARTIFACT_OPERATION_SCHEMA,
      required: true,
      description: 'One or more exact create, patch, or delete operations.',
    },
    rationale: { type: 'string' as const, required: true, description: 'Evidence-grounded reason for the mutation.' },
    evidenceRefs: { type: 'array' as const, items: { type: 'string' as const }, required: true, description: 'Current baseline eval/run refs supporting this proposal.' },
    expectedOutcome: { type: 'string' as const, required: true, description: 'Observable expected improvement.' },
  },
} as const

export function mountMetaCapabilityTools(agentCtx: Context, call: MetaCapabilityCaller): void {
  agentCtx.systemPrompt.section({
    name: 'refine-meta:capability-guide',
    order: 107,
    text: [
      'You are the fixed optimizer for one evolving target harness. You never run as the target harness.',
      'At each refinement-round wake, treat the embedded baseline as the authoritative current-round evidence.',
      'Before proposing, inspect trajectory diagnostics for every failed baseline run. Use raw event pages only for additional drill-down.',
      'Cite only the current baseline evalId/runIds that were exposed by the wake or typed tools. Held-out evidence is unavailable.',
      'Prefer the typed tools below for discovery and proposal submission. Use ipython_input for persistent analysis, scratch files, and sandboxed composition.',
      'trajectory_query without refs returns the current round summary. With refs=[evalId|runId], offset=0 includes whole-trajectory diagnostics plus a bounded raw event page.',
      'A non-null proposal must be {parentRef, parentDigest, target, ops, rationale, evidenceRefs, expectedOutcome}. Exact operation shapes are create={type,path,content,expect:"absent"}, patch={type,path,patch,expectedDigest}, delete={type,path,expectedDigest}. patch is a unified diff.',
      'Never submit a schema probe. Invalid fields, stale digests, and non-applying patches are rejected without consuming the round proposal, so inspect and retry with a real mutation.',
    ].join('\n'),
  })
  agentCtx.tools.register(defineTool({
    name: 'harness_current',
    description: 'Return the immutable current champion ref, digest, and target manifest.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('harness_current requires an agent session')
      return jsonValue(await call(String(exec.agent.id), 'harness.current', {}, exec.signal))
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'harness_read',
    description: 'Read one manifest-indexed file from the exact current champion commit.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Exact champion Git commit returned by harness_current.' },
      path: { type: 'string', required: true, description: 'Manifest-indexed relative artifact path.' },
      offset: { type: 'integer', description: 'Character offset; defaults to 0.' },
      limit: { type: 'integer', description: 'Bounded character count.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('harness_read requires an agent session')
      return jsonValue(await call(String(exec.agent.id), 'harness.read', args, exec.signal))
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'seed_tasks_load',
    description: 'Load the configured seed tasks. Held-out tasks cannot be requested.',
    parameters: { partition: { type: 'string', enum: ['seed'], description: 'Must be seed.' } },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('seed_tasks_load requires an agent session')
      return jsonValue(await call(String(exec.agent.id), 'seed_tasks.load', args, exec.signal))
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'trajectory_query',
    description: 'Read the current seed evidence summary or whole-trajectory diagnostics and a bounded raw event page for recorded eval/run refs.',
    parameters: {
      roundId: { type: 'string', description: 'Round to inspect; defaults to the active Meta round.' },
      refs: { type: 'array', items: { type: 'string' }, description: 'Recorded seed eval IDs or run IDs. Omit to get the round summary.' },
      offset: { type: 'integer', description: 'Raw event offset; defaults to 0.' },
      limit: { type: 'integer', description: 'Raw event limit, capped at 100; defaults to 20.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('trajectory_query requires an agent session')
      return jsonValue(await call(String(exec.agent.id), 'trajectory.query', args, exec.signal))
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'hitch_status',
    description: 'Return public seed baseline/candidate status for one refinement round.',
    parameters: { roundId: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('hitch_status requires an agent session')
      return jsonValue(await call(String(exec.agent.id), 'hitch.status', args, exec.signal))
    },
  }))
  agentCtx.tools.register(defineTool({
    name: 'submit_refinement_proposal',
    description: 'Submit one fully specified current-round HarnessMutation, or null for an evidence-based no-change decision. A valid submission concludes the Meta turn; invalid or non-applying mutations can be corrected and retried.',
    parameters: {
      roundId: { type: 'string', required: true },
      mutation: {
        required: true,
        oneOf: [
          HARNESS_MUTATION_SCHEMA,
          { type: 'null' },
        ],
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('submit_refinement_proposal requires an agent session')
      const value = jsonValue(await call(String(exec.agent.id), 'submit_refinement_proposal', args, exec.signal))
      exec.concludeTurn()
      return value
    },
  }))
}
