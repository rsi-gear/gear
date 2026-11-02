#!/usr/bin/env node
import { projectCommand } from './cli/project.js'
import { GearError } from './domain/errors.js'
import { requestRefineSkill } from './adapters/skill/client.js'
import { loadBundledRefineSkill } from './skill/bundle.js'
import pkg from '../package.json' with { type: 'json' }
const { version } = pkg

function usage(): never {
  throw new Error(
    'usage: gear version | gear serve --project DIRECTORY [--socket PATH] | gear skill-identity [--path DIRECTORY] | gear [--socket PATH] request <method> [json-params] [--request-id ID]',
  )
}

export async function main(argv: string[]): Promise<void> {
  const args = [...argv]
  if (args.includes('--version') || args.includes('version')) {
    process.stdout.write(`gear ${version}\n`)
    return
  }
  if (await projectCommand(args)) return
  if (args[0] === 'storage') {
    const { storageCommand } = await import('./state/storage-cli.js')
    process.stdout.write(`${JSON.stringify(await storageCommand(args.slice(1)), null, 2)}\n`)
    return
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
    process.stdout.write(
      `${JSON.stringify({ id: skill.name, digest: skill.digest, resources: skill.resources })}\n`,
    )
    return
  }
  if (args[0] !== undefined && args[0] !== '--socket' && args[0] !== 'request')
    throw new GearError('unknown-cli-command', `Unknown command: ${args[0]}. Run 'gear' for usage.`)
  let socketPath = process.env.GEAR_REFINE_SOCKET
  if (args[0] === '--socket') {
    args.shift()
    socketPath = args.shift()
  }
  if (socketPath === undefined || socketPath.length === 0)
    throw new Error('GEAR_REFINE_SOCKET or --socket is required')
  if (args.shift() !== 'request') usage()
  const requestIndex = args.indexOf('--request-id')
  let id: string | undefined
  if (requestIndex >= 0) {
    id = args[requestIndex + 1]
    if (!id || id.startsWith('--')) usage()
    args.splice(requestIndex, 2)
  }
  const method = args.shift()
  if (method === undefined || args.length > 1) usage()
  let params: unknown = {}
  if (args[0] !== undefined) params = JSON.parse(args[0])
  const result = await requestRefineSkill(socketPath, { method, params, ...(id === undefined ? {} : { id }) })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof GearError ? JSON.stringify(error.toJSON()) : error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
