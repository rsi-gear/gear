import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { publishFile } from '../storage/atomic.js'
import { withFileLock } from '../storage/file-lock.js'
import type { CodexInput } from './contracts.js'

interface Entry {
  digest: string
  state: 'admitted' | 'started' | 'fenced'
}
interface Journal {
  version: 1
  identity: string
  operations: Record<string, Entry>
}
const path = (input: CodexInput) => join(input.context.directory, 'operations.json')
const identity = (input: CodexInput) =>
  canonicalDigest({
    configuration: input.configuration,
    context: input.context,
    implementationIdentity: input.implementationIdentity,
  })
export function stateLost(): GearError {
  return new GearError('codex-state-unavailable', 'Original operation control state is unavailable')
}
/** Only new-run admission creates this namespace. Recovery must never recreate it. */
export async function initializeJournal(input: CodexInput): Promise<void> {
  await publishFile(path(input), JSON.stringify({ version: 1, identity: identity(input), operations: {} }), {
    immutable: true,
  })
}
async function readJournal(input: CodexInput): Promise<Journal> {
  try {
    const journal = JSON.parse(await readFile(path(input), 'utf8')) as Journal
    if (
      journal?.version !== 1 ||
      journal.identity !== identity(input) ||
      !journal.operations ||
      typeof journal.operations !== 'object' ||
      Array.isArray(journal.operations) ||
      Object.entries(journal.operations).some(
        ([id, entry]) =>
          !/^sha256:[a-f0-9]{64}$/u.test(id) ||
          !entry ||
          !/^sha256:[a-f0-9]{64}$/u.test(entry.digest) ||
          !['admitted', 'started', 'fenced'].includes(entry.state),
      )
    )
      throw stateLost()
    return journal
  } catch {
    throw stateLost()
  }
}
export async function withJournal<T>(
  input: CodexInput,
  action: (journal: Journal) => Promise<T>,
): Promise<T> {
  // Check before acquiring a lock: that helper can create its parent directory.
  await readJournal(input)
  return withFileLock(join(input.context.directory, 'control.lock'), async () =>
    action(await readJournal(input)),
  )
}
export async function registerOperation(input: CodexInput, journal: Journal, entry: Entry): Promise<void> {
  journal.operations[input.request!.operationId] = entry
  await publishFile(path(input), JSON.stringify(journal))
}
