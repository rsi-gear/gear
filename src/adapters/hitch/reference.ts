import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
// Hitch's Git cache and artifact builder initialize SHA-1 repositories.
// Admit SHA-256 only when resolution, transport and building all support it.
const fullCommit = /^[a-f0-9]{40}$/u

/** Hitch retains the requested source separately and records the executed OID. */
export function executedHarnessReference(value: string): string {
  const separator = value.indexOf('@git+')
  return separator < 0
    ? value
    : `${value.slice(0, separator)}@commit:${value.slice(value.lastIndexOf('#') + 1)}`
}

/** Accept immutable selectors supported by Hitch's container artifact builder. */
export function isPinnedHarnessReference(value: string): boolean {
  const separator = value.indexOf('@')
  if (!['deepseek', 'pi'].includes(value.slice(0, separator))) return false
  const selector = value.slice(separator + 1)
  if (selector.startsWith('version:')) return exactVersion.test(selector.slice('version:'.length))
  if (selector.startsWith('commit:')) return fullCommit.test(selector.slice('commit:'.length))
  if (!selector.startsWith('git+')) return false
  const hash = selector.lastIndexOf('#')
  if (hash < 0 || !fullCommit.test(selector.slice(hash + 1))) return false
  try {
    const source = selector.slice('git+'.length, hash)
    const localPath = resolve(fileURLToPath(source))
    // Keep the reference canonical so the profile and Hitch receipts agree.
    return (
      pathToFileURL(localPath).href === source &&
      ![...localPath].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
  } catch {
    return false
  }
}
