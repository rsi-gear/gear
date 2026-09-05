import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/config.js'

function requiredConfig(): Record<string, unknown> {
  return {
    workspaceRoot: '/workspace',
    dshRepository: '/target',
    metaModel: { provider: 'test', model: 'test-model' },
    dshBaseRef: 'a'.repeat(40),
    toolchainRef: 'toolchain-v1',
    sandboxProfileRef: 'sandbox-v1',
    seedTaskRef: 'seed',
    heldOutRef: 'held-out',
    compiler: { command: '/bin/true' },
    initialChampion: {
      schemaVersion: 2,
      ref: 'b'.repeat(40),
      manifestDigest: `sha256:${'c'.repeat(64)}`,
      updatedAt: 'initial',
    },
  }
}

describe('Gear configuration defaults', () => {
  it('defaults Meta integration to skill mode without requiring a preset', () => {
    const config = ConfigSchema(requiredConfig() as never)
    expect(config.metaAdapter.kind).toBe('skill')
    expect(config.metaPreset).toBeUndefined()
  })

  it('retains Native DSH only when it is selected explicitly', () => {
    const config = ConfigSchema({
      ...requiredConfig(),
      metaPreset: 'refine-meta',
      metaAdapter: { kind: 'dsh' },
    } as never)
    expect(config.metaAdapter.kind).toBe('dsh')
    expect(config.metaPreset).toBe('refine-meta')
  })
})
