import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import {
  pythonObjective,
  pythonObjectiveCompatible,
  pythonObjectiveFor,
} from '../../src/adapters/python/objective.js'
import { builtinPolicyImplementationDigest } from '../../src/adapters/python/builtin-policy.js'
import { policyReaderCompatible } from '../../src/adapters/python/policy-compatibility.js'

const historicalObjective = 'sha256:6b3ff878a989d346d7a6e73fdee94f4c36fb1866bc081efb11fd85c9a8a8c69e'
const historicalReader = 'sha256:41cae40c53d91a5263e1e0cdef7393360d242bfd32cfdeb2f550c811633bb43b'
const unknown = 'sha256:' + '0'.repeat(64)

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

it('binds the known historical identity to the unchanged scoring authority', () => {
  const selected = pythonObjectiveFor(historicalObjective)
  expect(selected.identity).toBe(historicalObjective)
  expect(selected.project).toBe(pythonObjective.project)
  expect(selected.compare).toBe(pythonObjective.compare)
  expect(pythonObjectiveFor(pythonObjective.identity).identity).toBe(pythonObjective.identity)
  expect(policyReaderCompatible(historicalReader)).toBe(true)
  expect(policyReaderCompatible(builtinPolicyImplementationDigest)).toBe(true)
  expect(pythonObjectiveCompatible(unknown)).toBe(false)
  expect(() => pythonObjectiveFor(unknown)).toThrow('Frozen objective implementation changed')
  expect(policyReaderCompatible(unknown)).toBe(false)
})

async function changeReadSource(suffix: string) {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
        const value = actual.readFileSync(...args)
        const path = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0])
        if (typeof value !== 'string' || !path.endsWith(suffix)) return value
        if (suffix.endsWith('/operators.py'))
          return value.replace(
            '"objective_compare": compare_candidates',
            '"objective_compare": project_candidate',
          )
        return value + '\n' + (suffix.endsWith('.py') ? '#' : '//') + ' changed executable source\n'
      }) as typeof actual.readFileSync,
    }
  })
  vi.resetModules()
}

it.each([
  '/python/gear/refine/operators.py',
  '/python/gear/refine/projection.py',
  '/python/gear/refine/builtin_transport.py',
  '/assets/python-policy-worker.cjs',
  '/src/adapters/python/objective.ts',
  '/src/adapters/python/packaged-policy.ts',
  '/src/adapters/python/builtin-policy.ts',
  '/src/domain/canonical.ts',
])('rejects historical scoring after changing executable source %s', async (suffix) => {
  await changeReadSource(suffix)
  const changed = await import('../../src/adapters/python/objective.js')
  expect(changed.pythonObjective.identity).not.toBe(pythonObjective.identity)
  expect(changed.pythonObjectiveCompatible(historicalObjective)).toBe(false)
  expect(() => changed.pythonObjectiveFor(historicalObjective)).toThrow(
    'Frozen objective implementation changed',
  )
})

it('rejects historical reader snapshots after their reviewed projection source changes', async () => {
  await changeReadSource('/python/gear/refine/experience.py')
  const changed = await import('../../src/adapters/python/policy-compatibility.js')
  expect(changed.policyReaderCompatible(historicalReader)).toBe(false)
})
