import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import { GearError } from '../../domain/errors.js'
import type { ProjectController } from '../../application/project-controller.js'
import { loadBundledRefineSkill } from '../../skill/bundle.js'

/** The operator's DSH session is separate from the frozen Meta execution profile. */
export async function mountProjectSkill(ctx: Context, controller: ProjectController): Promise<void> {
  const skill = await loadBundledRefineSkill()
  const definition = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'gear-project-bundled',
    resourceBase: { kind: 'directory' as const, path: dirname(skill.path) },
    path: skill.path,
  }
  ctx.skills.registerProvider(() => ({
    name: definition.provider,
    async list() {
      return [{ ...definition, rank: 0, locator: skill.name }]
    },
    async get() {
      return definition
    },
  }))
  ctx.tools.register(
    defineTool({
      name: 'refine_request',
      description:
        'Run Gear project commands using the same service as gear CLI and Python Project. Creating runs returns a durable run ID.',
      parameters: {
        method: {
          type: 'string',
          required: true,
          description: 'Project method, for example run.refine, run.report or benchmark.check.',
        },
        params: { type: 'json', required: true, description: 'Project command parameters.' },
        request_id: {
          type: 'string',
          description:
            'Stable ID for a create-run request. Reuse it after a lost response; changed parameters are rejected.',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args, exec) {
        if (!exec.agent)
          throw new GearError('session-required', 'refine_request requires an operator session')
        const bytes = Buffer.byteLength(JSON.stringify(args))
        if (bytes > controller.maxRequestBytes)
          throw new GearError('request-too-large', 'Project request exceeds the transport limit')
        // Tool retries share their host call ID. An explicit ID also survives a
        // model issuing a new tool call after a lost reply or session compaction.
        const id = args.request_id ?? `dsh:${String(exec.agent.id)}:${String(exec.callId)}`
        exec.signal.throwIfAborted()
        const value = await controller.call(args.method, args.params, id)
        return JSON.parse(JSON.stringify(value)) as JsonValue
      },
    }),
  )
}
