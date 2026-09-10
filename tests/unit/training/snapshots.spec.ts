import { describe, expect, it } from 'vitest'
import { datasetDestination } from '../../../src/training/snapshots.js'

describe('dataset identity across materialization', () => {
  it('preserves the logical dataset name under different content cache roots', () => {
    const manifest = { schemaVersion: 2, format: 'harbor-dataset', name: 'dataset' }
    expect(datasetDestination(manifest, '/controller/a')).toBe('/controller/a/dataset')
    expect(datasetDestination(manifest, '/worker/b')).toBe('/worker/b/dataset')
    expect(datasetDestination({ schemaVersion: 1, format: 'harbor-dataset' }, '/legacy')).toBe('/legacy')
  })
  it('rejects names that can escape or alias the content cache', () => {
    for (const name of ['', '.', '..', '/absolute', '../other', 'a/b', 'a\\b', 'a\0b', null]) {
      expect(() => datasetDestination({ schemaVersion: 2, format: 'harbor-dataset', name }, '/cache')).toThrow('one path component')
    }
  })
})
