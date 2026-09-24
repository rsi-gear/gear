import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALGORITHM_API_VERSION, AlgorithmRuntime, BindingStore, defineWorkflow, FileArtifactStore, sha256, task } from '../../../src/algorithm/index.js'
import type { BindingSchema, BindingSetRef, CampaignSpec } from '../../../src/algorithm/contracts.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gear-workflow-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindingSchema: BindingSchema = { id: 'workflow-bindings.v1', slots: { model: { schemaId: 'model.v1', required: true, replaceable: true } } }
  const bindings = new BindingStore(artifacts, bindingSchema)
  const initial = bindings.create({ model: artifacts.putJson({ name: 'H0' }, 'model.v1') })
  const next = bindings.derive(initial, { model: artifacts.putJson({ name: 'H1' }, 'model.v1') })
  const spec: CampaignSpec = { campaignId: 'workflow-pure-steps', config: {}, initialBindingSetRef: initial, budget: {} }
  return { root, bindingSchema, initial, next, spec }
}

describe('managed workflow pure steps', () => {
  it('advances bounded empty steps and carries a binding transition into the next operation', async () => {
    const f = setup(); const seen: BindingSetRef[] = []
    const workflow = defineWorkflow({
      manifest: { id: 'pure-steps', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('pure-steps-v1'),
        configSchema: { type: 'object', additionalProperties: true }, bindingSchema: f.bindingSchema },
      businessStateSchema: { type: 'object', properties: { visited: { type: 'array', items: { type: 'string' } } },
        required: ['visited'], additionalProperties: false },
      initialState: () => ({ visited: [] }),
      steps: [
        { name: 'switch', plan: () => [], join: ({ state }) => ({ state: { visited: [...(state as { visited: string[] }).visited, 'switch'] }, bindingTransition: f.next }) },
        { name: 'pure', plan: context => { seen.push(context.activeBindingSetRef); return [] },
          join: ({ state }) => ({ state: { visited: [...(state as { visited: string[] }).visited, 'pure'] } }) },
        { name: 'derive', plan: context => [task('derive', 'bindings.derive', { baseRef: context.activeBindingSetRef, replacements: {} })],
          join: ({ state }) => ({ state: { visited: [...(state as { visited: string[] }).visited, 'derive'] } }) },
      ],
    })
    const runtime = new AlgorithmRuntime(f.root, workflow, [], f.spec)
    expect(await runtime.tick()).toBe('advanced')
    expect(seen).toEqual([f.next])
    expect(runtime.snapshot()?.activeBindingSetRef).toEqual(f.next)
    expect(runtime.snapshot()?.operations.derive?.envelope.bindingSetRef).toEqual(f.next)
    expect(await runtime.runUntilBlocked()).toBe('complete')
    expect((runtime.snapshot()?.state as { business: { visited: string[] } }).business.visited).toEqual(['switch', 'pure', 'derive'])
  })

  it('finishes an all-pure workflow in one bounded decision', async () => {
    const f = setup()
    const workflow = defineWorkflow({
      manifest: { id: 'all-pure', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('all-pure-v1'),
        configSchema: { type: 'object', additionalProperties: true }, bindingSchema: f.bindingSchema },
      businessStateSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      initialState: () => ({ count: 0 }),
      steps: Array.from({ length: 64 }, (_, index) => ({ name: `pure-${index}`, plan: () => [],
        join: ({ state }: { state: unknown }) => ({ state: { count: (state as { count: number }).count + 1 } }) })),
    })
    const runtime = new AlgorithmRuntime(f.root, workflow, [], f.spec)
    expect(await runtime.tick()).toBe('complete')
    expect((runtime.snapshot()?.state as { business: { count: number } }).business.count).toBe(64)
  })
})
