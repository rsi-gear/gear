import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Persist the first start/cancel decision without replacing a competing record. */
export function durableCreate(path: string, contents: string): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeSync(descriptor, contents); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  let created = false
  try {
    try { linkSync(temporary, path); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally { unlinkSync(temporary) }
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return created
}
