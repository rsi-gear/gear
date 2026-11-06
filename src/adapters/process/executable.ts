import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { GearError } from '../../domain/errors.js'

export async function findExecutable(name: string): Promise<string> {
  for (const path of isAbsolute(name) || name.includes('/')
    ? [resolve(name)]
    : (process.env.PATH ?? '').split(delimiter).map((directory) => resolve(directory, name))) {
    try {
      await access(path, constants.X_OK)
      return await realpath(path)
    } catch {
      /* Next PATH entry. */
    }
  }
  throw new GearError('executable-unavailable', `Install or configure ${name}`)
}
