import { describe, expect, it, vi } from 'vitest'
import type { SkillHarnessIdentity } from '../../src/meta/skill.js'
import { loadBundledRefineSkill, mountDshRefineSkill } from '../../src/skill/dsh.js'

describe('DSH refine skill bridge', () => {
  it('publishes the packaged skill and binds native requests to the DSH session identity', async () => {
    const bundled = await loadBundledRefineSkill()
    const identity: SkillHarnessIdentity = {
      runtime: { type: 'dsh', version: 'test', integrity: `sha256:${'1'.repeat(64)}` },
      preset: { id: 'refine', digest: bundled.digest },
      model: { provider: 'test', model: 'test-model' },
      sampling: {},
    }
    let provider: { list(options: object): Promise<unknown>; get(candidate: unknown, options: object): Promise<unknown> } | undefined
    let tool: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
    const context = {
      skills: {
        registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => typeof provider) {
          provider = create({ signal: new AbortController().signal, invalidate() {} })
          return () => {}
        },
      },
      tools: {
        register(definition: typeof tool) { tool = definition; return () => {} },
      },
    }
    const call = vi.fn(async () => ({ leaseId: 'lease-1' }))
    await mountDshRefineSkill(context as never, { maxRequestBytes: 1024 * 1024, call } as never, identity)

    const candidates = await provider!.list({}) as Array<{ name: string; rank: number }>
    expect(candidates).toEqual([expect.objectContaining({ name: 'refine', rank: 0 })])
    await expect(provider!.get(candidates[0], {})).resolves.toEqual(expect.objectContaining({
      name: 'refine',
      content: expect.stringContaining('current tree as a starting state'),
      resourceBase: expect.objectContaining({ kind: 'directory' }),
    }))

    await tool!.execute({ method: 'meta.claim', params: { evolutionId: 'evo-1' } }, {
      agent: {
        id: 'agent-1',
        session: { requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
      },
      signal: new AbortController().signal,
    })
    expect(call).toHaveBeenCalledWith('meta.claim', {
      evolutionId: 'evo-1',
      clientId: 'dsh:agent-1',
      identity,
    })
    await expect(tool!.execute({ method: 'control.status', params: {} }, {
      agent: {
        id: 'agent-2',
        session: { requestHeader: () => ({ config: { provider: 'other', model: 'test-model' } }) },
      },
      signal: new AbortController().signal,
    })).rejects.toThrow('current DSH request identity does not match')
  })

  it('rejects a configured DSH identity that does not match the packaged skill', async () => {
    const identity: SkillHarnessIdentity = {
      runtime: { type: 'dsh', version: 'test', integrity: `sha256:${'1'.repeat(64)}` },
      preset: { id: 'refine', digest: `sha256:${'2'.repeat(64)}` },
      model: { provider: 'test', model: 'test-model' },
      sampling: {},
    }
    await expect(mountDshRefineSkill({} as never, {} as never, identity)).rejects.toThrow(
      'DSH skill mode must use the packaged refine skill identity',
    )
  })
})
