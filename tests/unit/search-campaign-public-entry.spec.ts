import { afterEach, describe, expect, it, vi } from 'vitest'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { FailureClusterSearch, SearchEvidencePending } from '../../src/search/engine.js'
import * as search from '../../src/search/index.js'
import * as contributor from '../../src/search/api.js'
import * as preset from '../../src/search/presets/failure-cluster-gepa.js'
import { SearchEvidencePending as OutcomePending } from '../../src/search/outcomes.js'
import type { CommitIntent, SearchEvolutionIdentity, SearchRoundOutcome } from '../../src/search/engine.js'

// Compile-time coverage for the prior engine type exports.
const retainTypes = (_identity: SearchEvolutionIdentity, _outcome: SearchRoundOutcome,
  _intent: CommitIntent): void => {}
void retainTypes

afterEach(() => { vi.doUnmock('node:fs'); vi.resetModules() })

describe('public FailureClusterSearch switch', () => {
  it('keeps the public and preset class aliases and a single pending-error constructor', () => {
    expect(FailureClusterSearch).toBe(CampaignFailureClusterSearch)
    expect(search.FailureClusterSearch).toBe(CampaignFailureClusterSearch)
    expect(preset.FailureClusterSearch).toBe(CampaignFailureClusterSearch)
    expect(SearchEvidencePending).toBe(OutcomePending)
    expect(search.SearchEvidencePending).toBe(OutcomePending)
    expect(new SearchEvidencePending('plan').message).toBe('search stage needs evidence repair: plan')
    expect(contributor.SearchStore).toBeTypeOf('function')
  })

  it('changes the search identity when shipped Campaign execution files change', async () => {
    let altered: string | null = null
    vi.doMock('node:fs', async () => {
      const original = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...original, readFileSync: ((path: unknown, ...options: unknown[]): unknown => {
        const bytes = Reflect.apply(original.readFileSync, original, [path, ...options]) as string | Buffer
        if (!altered || !String(path).endsWith(altered)) return bytes
        return typeof bytes === 'string' ? `${bytes}\n// identity mutation\n`
          : Buffer.concat([bytes, Buffer.from('\n// identity mutation\n')])
      }) as typeof original.readFileSync }
    })
    const digest = async () => {
      vi.resetModules()
      return (await import('../../src/search/identity.js')).searchImplementationIntegrity
    }
    const baseline = await digest()
    for (const file of ['/search/campaign-engine.ts', '/algorithm/recipes/gepa.ts',
      '/algorithm/providers/gepa-operations.ts', '/algorithm/runtime/engine.ts',
      '/search/schema.json', '/search/archive.ts']) {
      altered = file
      expect(await digest(), `missing identity closure coverage for ${file}`).not.toBe(baseline)
    }
  })
})
