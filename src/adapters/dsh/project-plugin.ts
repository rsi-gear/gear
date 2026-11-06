import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import { GearError } from '../../domain/errors.js'
import { createProjectControlPlane } from '../../application/control-plane.js'
import type { ProjectController } from '../../application/project-controller.js'
import { mountProjectSkill } from './project-skill.js'
import { parseProjectCommand } from '../../cli/project-input.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gear: ProjectController
  }
}
export const name = 'refine'
export const inject = ['commands', 'tools', 'skills']
export interface ProjectPluginConfig {
  projectRoot: string
  socketPath?: string
}
export const Config = Schema.object({ projectRoot: Schema.string().required(), socketPath: Schema.string() })
export async function apply(ctx: Context, config: ProjectPluginConfig): Promise<void> {
  if (
    !config ||
    Object.keys(config).some((key) => !['projectRoot', 'socketPath'].includes(key)) ||
    !config.projectRoot
  )
    throw new GearError(
      'invalid-plugin-config',
      'Configure projectRoot and optionally socketPath; execution settings belong in gear.yaml and provider profiles',
    )
  const control = await createProjectControlPlane(
    config.projectRoot,
    config.socketPath === undefined ? {} : { socketPath: config.socketPath },
  )
  try {
    await mountProjectSkill(ctx, control.controller)
    ctx.provide('gear', control.controller)
    ctx.commands.register({
      name: 'gear',
      description: 'Check, run, inspect, resume or cancel the configured Gear project.',
      input: {
        hint: 'refine [--rounds N] | evaluate --split seed | report [RUN_ID] | resume RUN_ID | cancel RUN_ID',
      },
      async handler(invocation) {
        try {
          const command = parseProjectCommand(invocation.rawInput)
          return {
            kind: 'success',
            text: JSON.stringify(await control.controller.call(command.method, command.params)),
          }
        } catch (error) {
          return {
            kind: 'error',
            text: JSON.stringify(
              error instanceof GearError
                ? error.toJSON()
                : {
                    code: 'project-command-failed',
                    message: error instanceof Error ? error.message : String(error),
                  },
            ),
          }
        }
      },
    })
    ctx.effect(() => () => control.dispose(), 'gear.project.dispose()')
  } catch (error) {
    await control.dispose()
    throw error
  }
}
