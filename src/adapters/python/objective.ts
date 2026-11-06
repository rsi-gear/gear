import { readFileSync } from 'node:fs'
import { canonicalDigest } from '../../domain/canonical.js'
import type { ObjectiveProjector } from '../../ports/objective.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from './builtin-policy.js'

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const identity = canonicalDigest([
  builtinPolicyImplementationDigest,
  ...[
    './objective',
    '../../domain/objective-evidence',
    '../../domain/assertion-evidence',
    '../../domain/verifier-evidence',
    '../../objective/contracts',
  ].map((module) => readFileSync(new URL(`${module}${extension}`, import.meta.url), 'utf8')),
])

export const pythonObjective: ObjectiveProjector = {
  identity,
  project: (input) => builtinPolicy('objective_project', input),
  compare: (input) => builtinPolicy('objective_compare', input),
}
