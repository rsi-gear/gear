import { fileURLToPath } from 'node:url'
import { capturePolicySources, createPackagedPolicy } from './packaged-policy.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const builtinPolicySources: Readonly<Record<string, string>> = Object.freeze({
  ...capturePolicySources(root, [
    'gear/__init__.py',
    'gear/project.py',
    'gear/canonical.py',
    'gear/experience.py',
    'gear/experience_store.py',
    'gear/refine/__init__.py',
    ...[
      'assertions',
      'experience',
      'experience_index',
      'meta',
      'objective',
      'operators',
      'projection',
      'research',
      'verifier',
    ].map((name) => `gear/refine/${name}.py`),
    'gear/observations/__init__.py',
    'gear/observations/modification_use.py',
    'gear/observations/trajectory.py',
    'gear/training/policy.py',
  ]),
  // The policy interpreter needs no training loop, storage or backend imports.
  'gear/training/__init__.py': '"""Frozen pure training policy package."""\n',
})
// Capture only current shipped policies; historical fixtures have their own client.
export const { builtinPolicy, builtinPolicyImplementationDigest } = createPackagedPolicy(
  root,
  builtinPolicySources,
)
