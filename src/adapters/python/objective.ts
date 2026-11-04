import { readFileSync } from 'node:fs'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ObjectiveProjector } from '../../ports/objective.js'
import { builtinPolicy, builtinPolicySources } from './builtin-policy.js'
import { historicalObjectiveCompatible } from './objective-compatibility.js'

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
// Recipe changes cannot alter the identity of the independent scoring authority.
const scoringClosure = canonicalDigest({
  python: ['canonical', 'assertions', 'objective', 'projection', 'verifier'].map(
    (name) => builtinPolicySources[name === 'canonical' ? 'gear/canonical.py' : `gear/refine/${name}.py`],
  ),
  dispatch: builtinPolicySources['gear/refine/operators.py'],
  contracts: [
    '../../domain/objective-evidence',
    '../../domain/assertion-evidence',
    '../../domain/verifier-evidence',
    '../../objective/contracts',
  ].map((module) => readFileSync(new URL(`${module}${extension}`, import.meta.url), 'utf8')),
  execution: [
    new URL(import.meta.url),
    new URL(`./packaged-policy${extension}`, import.meta.url),
    new URL(`./builtin-policy${extension}`, import.meta.url),
    new URL(`../../domain/canonical${extension}`, import.meta.url),
    new URL('../../../python/gear/refine/builtin_transport.py', import.meta.url),
    new URL('../../../assets/python-policy-worker.cjs', import.meta.url),
  ].map((path) => readFileSync(path, 'utf8')),
})

export const pythonObjective: ObjectiveProjector = {
  identity: canonicalDigest(['gear-objective-v2', scoringClosure]),
  project: (input) => builtinPolicy('objective_project', input),
  compare: (input) => builtinPolicy('objective_compare', input),
}

export function pythonObjectiveCompatible(identity: string | undefined): boolean {
  return identity === pythonObjective.identity || historicalObjectiveCompatible(identity, scoringClosure)
}

/** Preserve the frozen identity only after proving its entire scoring closure is unchanged. */
export function pythonObjectiveFor(identity: string | undefined): ObjectiveProjector {
  if (!pythonObjectiveCompatible(identity))
    throw new GearError(
      'objective-identity-mismatch',
      'Frozen objective implementation changed; use the matching runtime',
    )
  return { ...pythonObjective, identity: identity! }
}
