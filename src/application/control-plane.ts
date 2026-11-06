import { join, resolve } from 'node:path'
import { RefineSkillServer } from '../adapters/skill/server.js'
import { ProjectApplication, type ProjectBindings } from './project-service.js'
import { ProjectController } from './project-controller.js'
import { configuredBindings } from './profiles.js'
import { resolveProject } from './project-config.js'

export async function createProjectControlPlane(
  root: string,
  options: { socketPath?: string; bindings?: ProjectBindings } = {},
) {
  root = resolve(root)
  await resolveProject(root)
  const socketPath = resolve(options.socketPath ?? join(root, '.gear', 'control.sock'))
  const application = new ProjectApplication(root, options.bindings ?? configuredBindings)
  const controller = new ProjectController(application)
  const server = new RefineSkillServer(socketPath, controller)
  try {
    await server.start()
  } catch (error) {
    await server.dispose().catch(() => {})
    await controller.dispose()
    throw error
  }
  return {
    socketPath,
    application,
    controller,
    async dispose() {
      // Close admission first; then interrupt owned runs without requesting cancellation.
      try {
        await server.dispose()
      } finally {
        await controller.dispose()
      }
    },
  }
}
