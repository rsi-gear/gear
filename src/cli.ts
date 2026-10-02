#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { ConfigSchema } from './config.js'
import { requestRefineSkill } from './skill/client.js'
import { createSkillControlPlane } from './skill/control-plane.js'
import { loadBundledRefineSkill } from './skill/bundle.js'

function usage(): never {
  throw new Error('usage: gear-refine serve --config PATH | gear-refine skill-identity [--path DIRECTORY] | gear-refine [--socket PATH] request <method> [json-params]')
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv]
  if (args[0] === 'storage') {
    const { storageCommand } = await import('./state/storage-cli.js')
    process.stdout.write(`${JSON.stringify(await storageCommand(args.slice(1)), null, 2)}\n`); return
  }
  if (args[0] === 'training') {
    const { trainingCommand } = await import('./training/cli.js')
    process.stdout.write(`${JSON.stringify(await trainingCommand(args.slice(1)), null, 2)}\n`)
    return
  }
  if (args[0] === 'skill-identity') {
    args.shift()
    let directory: string | undefined
    if (args.length > 0) {
      if (args.shift() !== '--path') usage()
      directory = args.shift()
      if (directory === undefined || args.length > 0) usage()
    }
    const skill = await loadBundledRefineSkill(directory)
    process.stdout.write(`${JSON.stringify({ id: skill.name, digest: skill.digest, resources: skill.resources })}\n`)
    return
  }
  if (args[0] === 'serve') {
    args.shift()
    if (args.shift() !== '--config') usage()
    const configPath = args.shift()
    if (configPath === undefined || args.length > 0) usage()
    const input = JSON.parse(await readFile(configPath, 'utf8')) as never
    const controlPlane = await createSkillControlPlane(ConfigSchema(input))
    process.stdout.write(`${JSON.stringify({ ready: true, socketPath: controlPlane.socketPath })}\n`)
    const stopping = Promise.withResolvers<void>()
    const stop = (): void => stopping.resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    await stopping.promise
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await controlPlane.dispose()
    return
  }
  let socketPath = process.env.GEAR_REFINE_SOCKET
  if (args[0] === '--socket') {
    args.shift()
    socketPath = args.shift()
  }
  if (socketPath === undefined || socketPath.length === 0) throw new Error('GEAR_REFINE_SOCKET or --socket is required')
  if (args.shift() !== 'request') usage()
  const method = args.shift()
  if (method === undefined || args.length > 1) usage()
  let params: unknown = {}
  if (args[0] !== undefined) params = JSON.parse(args[0])
  const result = await requestRefineSkill(socketPath, { method, params })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
