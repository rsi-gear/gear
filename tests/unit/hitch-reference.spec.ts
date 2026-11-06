import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isPinnedHarnessReference, executedHarnessReference } from '../../src/adapters/hitch/reference.js'
import { validateProfile } from '../../src/application/profile-store.js'

const commit = 'a'.repeat(40)
const customSource = pathToFileURL(join(tmpdir(), 'custom carrier')).href
const base = { kind: 'hitch', executable: 'hitch', root: '/hitch', model: 'fixture',
  baseImage: 'python@sha256:' + 'b'.repeat(64), passEnv: [], timeoutMs: 1000 }

it.each(['deepseek', 'pi'])('accepts immutable registered and custom Git runtimes for %s', (harness) => {
  for (const selector of ['version:0.1.5-rc.3', `commit:${commit}`, `git+${customSource}#${commit}`]) {
    const harnessRef = `${harness}@${selector}`
    expect(isPinnedHarnessReference(harnessRef)).toBe(true)
    expect(validateProfile({ ...base, harnessRef })).toMatchObject({ harnessRef })
    expect(executedHarnessReference(harnessRef)).toBe(selector.startsWith('git+')
      ? `${harness}@commit:${selector.slice(selector.lastIndexOf('#') + 1)}` : harnessRef)
  }
})

it.each(['installed', 'version:latest', 'version:1.x', 'version:1', 'commit:abc1234',
  `commit:${'a'.repeat(41)}`, `git+file:///runtime#${'a'.repeat(41)}`,
  `commit:${'a'.repeat(64)}`, `git+${customSource}#${'a'.repeat(64)}`,
  'git+file:///runtime#main', `git+https://example.com/runtime#${commit}`,
  `git+file:///runtime%0a#${commit}`, `git+file:///runtime?extra#${commit}`,
  `git+file:///runtime/../other#${commit}`, `git+${customSource}/#${commit}`,
  `git+${customSource}//#${commit}`])('rejects unsupported, mutable or noncanonical runtime %s', (selector) => {
  for (const harness of ['deepseek', 'pi']) {
    const harnessRef = `${harness}@${selector}`
    expect(isPinnedHarnessReference(harnessRef)).toBe(false)
    expect(() => validateProfile({ ...base, harnessRef })).toThrow(/pinned harness/)
  }
})
