import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { implementationClosureDigest } from '../algorithm/data/identity.js'

export const searchProtocolVersion = 2
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
// Shipped implementation bytes, not a manually incremented algorithm revision.
// Testkit, docs and public export facades do not affect running experiments.
const modules = ['identity', 'contracts', 'engine', 'runtime', 'archive', 'parent-selection', 'parent-random',
  'policies/parents', 'config', 'completion', 'dataset-projection', 'diagnosis', 'epochs', 'evaluation-adapter',
  'evidence', 'objective', '../objective/contracts', '../objective/scoring', 'promotion', 'recovery', 'regression', 'schema', 'scope-sampling', 'scopes', 'store', '../state/digest', '../evolution/component-ref', '../evolution/implementation-files', '../evolution/component-identity', '../evolution/builtin-algorithms', '../evolution/components']

// Pin the shipped Campaign implementation even if a provider is temporarily
// absent from one host's catalog. The scanner follows transitive imports and
// hashes the actual source/build bytes and installed dependency closure.
const campaignEntrypoints = [
  '../search/campaign-engine', '../search/campaign-admission',
  '../search/campaign-repair', '../search/campaign-identity',
  '../search/campaign-progress', '../search/outcomes',
  'recipes/gepa-search', 'recipes/gepa', 'recipes/gepa-policy',
  'recipes/gepa-round', 'recipes/gepa-budget',
  'providers/gepa-operations', 'providers/gepa-publication',
  'providers/gepa-hooks', 'providers/gepa-research-checkpoint',
  'providers/gepa-science-checkpoint', 'providers/gepa-archive-view',
  'providers/gepa-await-repair', 'providers/gepa-objective-reference',
  'providers/gepa-repair-evaluation', 'providers/gepa-process-completion',
  'providers/gepa-budget-projection',
  'runtime/engine', 'runtime/store', 'runtime/persistence',
  'runtime/providers', 'runtime/identity', 'contracts', 'artifacts',
  'bindings', 'schema', 'provider-errors', 'data/identity',
] as const

const hash = createHash('sha256').update(`gear-search-protocol:${searchProtocolVersion}\0`)
for (const file of [...modules.map(name => `${name}${extension}`), 'schema.json']) {
  const bytes = readFileSync(new URL(file, import.meta.url))
  hash.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0')
}
const closure = implementationClosureDigest(campaignEntrypoints, {
  algorithm: 'failure-cluster-search', protocolVersion: searchProtocolVersion,
})
hash.update('campaign-implementation-closure\0').update(closure).update('\0')
export const searchImplementationIntegrity = `sha256:${hash.digest('hex')}`
