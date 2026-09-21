import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const searchProtocolVersion = 2
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
// Shipped implementation bytes, not a manually incremented algorithm revision.
// Testkit, docs and public export facades do not affect running experiments.
const modules = ['identity', 'contracts', 'engine', 'runtime', 'archive', 'parent-selection', 'parent-random',
  'policies/parents', 'config', 'completion', 'dataset-projection', 'diagnosis', 'epochs', 'evaluation-adapter',
  'evidence', 'objective', '../objective/contracts', '../objective/scoring', 'promotion', 'recovery', 'regression', 'schema', 'scope-sampling', 'scopes', 'store', '../state/digest', '../evolution/component-ref', '../evolution/implementation-files', '../evolution/component-identity', '../evolution/builtin-algorithms', '../evolution/components']
const hash = createHash('sha256').update(`gear-search-protocol:${searchProtocolVersion}\0`)
for (const file of [...modules.map(name => `${name}${extension}`), 'schema.json']) {
  const bytes = readFileSync(new URL(file, import.meta.url))
  hash.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
}
export const searchImplementationIntegrity = `sha256:${hash.digest('hex')}`
