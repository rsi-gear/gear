import { fileURLToPath } from 'node:url'
import { capturePolicySources, createPackagedPolicy } from './packaged-policy.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const builtinPolicySources = Object.freeze(
  capturePolicySources(root, [
    'gear/__init__.py',
    'gear/project.py',
    'gear/canonical.py',
    'gear/experience.py',
    'gear/experience_store.py',
    'gear/algorithms',
  ]),
)
// Capture only current shipped policies; historical fixtures have their own client.
export const { builtinPolicy, builtinPolicyImplementationDigest } = createPackagedPolicy(
  root,
  builtinPolicySources,
)
