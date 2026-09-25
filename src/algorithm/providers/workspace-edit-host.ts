import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DshMetaAgentHost } from '../../meta/session.js'
import type { CandidateWorkspaceManager } from '../../candidate/workspace.js'
import { HarnessBuilder } from '../../harness/builder.js'
import { SkillCandidateFiles } from '../../skill/files.js'
import { canonicalJson, type JsonValue } from '../schema.js'
import { WorkspaceEditSessionRegistry } from './workspace-edit.js'

function required(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 * 1024)
    throw new Error('Workspace editor tool argument is invalid or too large')
  return value
}
function writeRequest(raw: string): { path: string; text: string; expectedDigest: string | null } {
  const input = JSON.parse(required(raw)) as Record<string, unknown>
  if (!input || typeof input !== 'object' || typeof input.path !== 'string'
    || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 256 * 1024
    || (input.expectedDigest !== null && typeof input.expectedDigest !== 'string'))
    throw new Error('Workspace write request must contain path, text and expectedDigest/null')
  return { path: required(input.path), text: input.text,
    expectedDigest: input.expectedDigest === null ? null : required(input.expectedDigest) }
}
function output() { return { schema: { type: 'json' as const }, render(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: canonicalJson(value) }]
} } }

/** Mount only operation-bound file and evidence tools. The caller must provide an isolated Meta preset. */
export function createWorkspaceEditDshHost(ctx: Context, sessions: WorkspaceEditSessionRegistry,
  files: SkillCandidateFiles, workspaces: CandidateWorkspaceManager, builder: HarnessBuilder): DshMetaAgentHost {
  return new DshMetaAgentHost(ctx, (agentCtx, sessionId) => {
    const owned = (agent: unknown) => {
      if (String(agent) !== sessionId) throw new Error('Workspace editor tool session identity mismatch')
      sessions.require(sessionId)
    }
    agentCtx.tools.register(defineTool({ name: 'workspace_tree', description: 'List only the operation-owned candidate harness tree.',
      parameters: { path: { type: 'string', required: true } }, output: output(),
      async execute(args, exec) { owned(exec.agent?.id); return await files.tree(sessionId, required(args.path)) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workspace_read', description: 'Read one candidate harness text file.',
      parameters: { path: { type: 'string', required: true } }, output: output(),
      async execute(args, exec) { owned(exec.agent?.id); return await files.read(sessionId, required(args.path)) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workspace_write', description: 'CAS-write one candidate harness text file.',
      parameters: { requestJson: { type: 'string', required: true } }, output: output(),
      async execute(args, exec) { owned(exec.agent?.id)
        const request = writeRequest(args.requestJson)
        return await files.write(sessionId, request.path, request.text, request.expectedDigest) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workspace_edit', description: 'CAS-replace one exact string in a candidate file.',
      parameters: { path: { type: 'string', required: true }, oldString: { type: 'string', required: true },
        newString: { type: 'string', required: true }, expectedDigest: { type: 'string', required: true } },
      output: output(),
      async execute(args, exec) { owned(exec.agent?.id)
        return await files.edit(sessionId, required(args.path), required(args.oldString),
          required(args.newString), required(args.expectedDigest)) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workspace_remove', description: 'CAS-remove one candidate harness text file.',
      parameters: { path: { type: 'string', required: true }, expectedDigest: { type: 'string', required: true } },
      output: output(),
      async execute(args, exec) { owned(exec.agent?.id)
        return await files.remove(sessionId, required(args.path), required(args.expectedDigest)) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workspace_check', description: 'Run the fixed physical compiler check on the candidate.',
      parameters: {}, output: output(),
      async execute(_args, exec) { owned(exec.agent?.id)
        const { workspaceId, deadlineAt } = sessions.require(sessionId)
        if (Date.now() >= deadlineAt) throw new Error('Workspace editor deadline exhausted')
        const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))
        const summary = await workspaces.preflight(workspaceId, signal)
        const report = await workspaces.withOpenWorkspace(sessionId, true,
          handle => builder.checkWorkspace(handle, signal))
        return { summary, report } as unknown as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'workplan_read', description: 'Read the exact assigned GEPA workplan and dossier.',
      parameters: {}, output: output(),
      async execute(_args, exec) { owned(exec.agent?.id); return sessions.markWorkplan(sessionId) as JsonValue },
    }))
    agentCtx.tools.register(defineTool({ name: 'diagnosis_read', description: 'Read one evidence ref required by the assigned GEPA workplan.',
      parameters: { ref: { type: 'string', required: true } }, output: output(),
      async execute(args, exec) { owned(exec.agent?.id); return sessions.markDiagnosis(sessionId, required(args.ref)) as unknown as JsonValue },
    }))
  })
}
