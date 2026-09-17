import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ComponentImplementation } from './component-ref.js'

/** Hash the package's shipped implementation files, including its manifest and local dependencies. */
export function implementationFromFiles(packageName: string, version: string, files: readonly URL[]): ComponentImplementation {
  if (!packageName || !version || !files.length) throw new TypeError('implementation requires a package, version and files')
  const hash = createHash('sha256')
  for (const file of files) {
    const bytes = readFileSync(file)
    hash.update(String(bytes.length)).update('\0').update(bytes).update('\0')
  }
  return { package: packageName, version, integrity: `sha256:${hash.digest('hex')}` }
}
