import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { componentRef, ComponentRegistry } from '../../src/evolution/components.js'
import {
  builtinImplementation,
  hitchCliImplementation,
  stableLlmVerifierImplementation,
} from '../../src/evolution/component-identity.js'
import type { ComponentKind, ComponentRef, PromotionPolicy } from '../../src/types.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/component-identity-v1-812195f/', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function copiedFixture(): Promise<string> {
  const root = await mkdtemp('/tmp/gear-component-v1-')
  roots.push(root)
  await cp(FIXTURE, root, { recursive: true })
  return root
}

async function legacyBuiltin(kind: ComponentKind, id: string, root = FIXTURE): Promise<ComponentRef<unknown>> {
  const [moduleBytes, manifestBytes] = await Promise.all([
    readFile(join(root, 'lib/evolution/components.js')),
    readFile(join(root, 'package.json')),
  ])
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name: string; version: string }
  const integrity = `sha256:${createHash('sha256')
    .update(moduleBytes).update('\0').update(manifestBytes).update('\0')
    .update(JSON.stringify({ package: manifest.name, version: manifest.version, kind, id, apiVersion: 1 }))
    .digest('hex')}`
  return componentRef(kind, id, { package: manifest.name, version: manifest.version, integrity }, {})
}

async function legacyVerifier(root = FIXTURE): Promise<ComponentRef<unknown>> {
  const [moduleBytes, bridgeBytes, manifestBytes] = await Promise.all([
    readFile(join(root, 'lib/selection/llm-verifier.js')),
    readFile(join(root, 'assets/llm-verifier-bridge.py')),
    readFile(join(root, 'package.json')),
  ])
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name: string; version: string }
  const integrity = `sha256:${createHash('sha256')
    .update(moduleBytes).update('\0').update(bridgeBytes).update('\0').update(manifestBytes).digest('hex')}`
  return componentRef('candidate-assessor', 'llm-verifier', {
    package: manifest.name, version: manifest.version, integrity,
  }, {})
}

function registerExternalBuiltins(registry: ComponentRegistry): void {
  const hitch = hitchCliImplementation()
  registry.registerRolloutProvider('hitch-cli', hitch, ref => ({
    ref,
    createEvaluator: () => { throw new Error('test factory must not execute') },
  }))
  const verifier = stableLlmVerifierImplementation()
  registry.registerCandidateAssessor('llm-verifier', verifier, ref => ({
    ref,
    async assess() { throw new Error('test factory must not execute') },
  }))
}

describe('component implementation identity', () => {
  it('preserves unchanged 812195f V1 components and rejects the changed Gear Hitch adapter', async () => {
    expect(createHash('sha256').update(await readFile(join(FIXTURE, 'package.json'))).digest('hex'))
      .toBe('1cc82968e633da5e6d7d766da8bc1231719c3f8e7f9ee5eae2fbf47c801f2a48')
    expect(createHash('sha256').update(await readFile(join(FIXTURE, 'lib/evolution/components.js'))).digest('hex'))
      .toBe('9f5c06ac68dc7e56a37534e2536c43c41cc03c1dbb0fecc641cfe8a3d6918cb7')

    const registry = new ComponentRegistry({ legacyComponentRoots: [FIXTURE] })
    registerExternalBuiltins(registry)
    const refs = await Promise.all([
      legacyBuiltin('candidate-generator', 'dsh-meta-forked-proposals'),
      legacyBuiltin('candidate-generator', 'meta-forked-proposals'),
      legacyBuiltin('task-sampler', 'dataset'),
      legacyBuiltin('candidate-assessor', 'evaluation-metrics'),
      legacyBuiltin('candidate-selector', 'highest-quality'),
      legacyBuiltin('judge', 'task-reward'),
      legacyBuiltin('promotion-policy', 'paired-gate'),
      legacyBuiltin('rollout-provider', 'hitch-cli'),
      legacyVerifier(),
    ])
    const resolved = [
      registry.candidateGenerator(refs[0]!), registry.candidateGenerator(refs[1]!),
      registry.taskSampler(refs[2]!), registry.assessor(refs[3]!), registry.selector(refs[4]!),
      registry.judge(refs[5]!), registry.promotionPolicy(refs[6]! as ComponentRef<PromotionPolicy>),
      registry.assessor(refs[8]!),
    ]
    expect(resolved.map(value => value.ref)).toEqual(refs.filter((_, index) => index !== 7))
    // Search submission identity and recovery now extend Gear's evaluator closure.
    // Do not accept an old opaque rollout identity as proof of these new bytes.
    expect(() => registry.rolloutProvider(refs[7]!)).toThrow(/do not prove the same implementation/u)
  })

  it('accepts publishing metadata drift but rejects freshly sealed algorithm drift', async () => {
    const root = await copiedFixture()
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, description: 'metadata only', scripts: { changed: 'true' } }, null, 2)}\n`)
    const metadataRef = await legacyBuiltin('candidate-generator', 'meta-forked-proposals', root)
    expect(new ComponentRegistry({ legacyComponentRoots: [root] }).candidateGenerator(metadataRef).ref).toEqual(metadataRef)

    const componentPath = join(root, 'lib/evolution/components.js')
    const source = await readFile(componentPath, 'utf8')
    await writeFile(componentPath, source.replace('parents.length === 0', 'parents.length < 0'))
    const changed = await legacyBuiltin('candidate-generator', 'meta-forked-proposals', root)
    expect(() => new ComponentRegistry({ legacyComponentRoots: [root] }).candidateGenerator(changed))
      .toThrow(/do not prove the same implementation/u)
  })

  it('rejects changed digest imports for both builtins and the LLM verifier', async () => {
    const root = await copiedFixture()
    const digestPath = join(root, 'lib/state/digest.js')
    const digestSource = await readFile(digestPath, 'utf8')
    await writeFile(digestPath, digestSource.replace(
      "import { createHash } from 'node:crypto';",
      "import { createHash } from 'untrusted-crypto';",
    ))
    const registry = new ComponentRegistry({ legacyComponentRoots: [root] })
    registerExternalBuiltins(registry)

    const builtin = await legacyBuiltin('candidate-selector', 'highest-quality', root)
    const verifier = await legacyVerifier(root)
    expect(() => registry.selector(builtin)).toThrow(/do not prove the same implementation/u)
    expect(() => registry.assessor(verifier)).toThrow(/do not prove the same implementation/u)
  })

  it('rejects freshly sealed legacy modules with extra top-level execution', async () => {
    const root = await copiedFixture()
    const componentPath = join(root, 'lib/evolution/components.js')
    await writeFile(componentPath, `${await readFile(componentPath, 'utf8')}\nObject.freeze({ unexpected: true });\n`)
    const changed = await legacyBuiltin('candidate-generator', 'meta-forked-proposals', root)
    const verifier = await legacyVerifier(root)
    const registry = new ComponentRegistry({ legacyComponentRoots: [root] })
    registerExternalBuiltins(registry)
    expect(() => new ComponentRegistry({ legacyComponentRoots: [root] }).candidateGenerator(changed))
      .toThrow(/do not prove the same implementation/u)
    expect(() => registry.assessor(verifier)).toThrow(/do not prove the same implementation/u)
  })

  it('rejects a freshly sealed executable legacy package initializer without executing it', async () => {
    const root = await copiedFixture()
    const componentPath = join(root, 'lib/evolution/components.js')
    const source = await readFile(componentPath, 'utf8')
    await writeFile(componentPath, source.replace(
      "const PACKAGE_NAME = 'dsh-plugin-refine';",
      "const PACKAGE_NAME = (() => { Array.prototype.sort = () => []; return 'dsh-plugin-refine'; })();",
    ))
    const changed = await legacyBuiltin('candidate-generator', 'meta-forked-proposals', root)
    const verifier = await legacyVerifier(root)
    const registry = new ComponentRegistry({ legacyComponentRoots: [root] })
    registerExternalBuiltins(registry)
    expect(() => new ComponentRegistry({ legacyComponentRoots: [root] }).candidateGenerator(changed))
      .toThrow(/do not prove the same implementation/u)
    expect(() => registry.assessor(verifier)).toThrow(/do not prove the same implementation/u)
    expect([3, 1, 2].sort()).toEqual([1, 2, 3])
  })

  it('never uses a legacy proof for a custom registration or an implementation with extra fields', async () => {
    const legacy = await legacyBuiltin('rollout-provider', 'hitch-cli')
    const registry = new ComponentRegistry({ legacyComponentRoots: [FIXTURE] })
    const custom = { package: 'custom', version: '1', integrity: `sha256:${'a'.repeat(64)}` }
    registry.registerRolloutProvider('hitch-cli', custom, ref => ({
      ref,
      createEvaluator: () => { throw new Error('test factory must not execute') },
    }))
    expect(() => registry.rolloutProvider(legacy)).toThrow(/implementation identity mismatch/u)

    const builtinRegistry = new ComponentRegistry({ legacyComponentRoots: [FIXTURE] })
    const withExtra = structuredClone(await legacyBuiltin('candidate-selector', 'highest-quality')) as ComponentRef<unknown> & {
      implementation: ComponentRef<unknown>['implementation'] & { source: string }
    }
    withExtra.implementation.source = 'unsealed'
    expect(() => builtinRegistry.selector(withExtra)).toThrow(/do not prove the same implementation/u)
  })

  it('gives each current component a stable schema identity instead of the Gear release version', () => {
    const generator = builtinImplementation('candidate-generator', 'meta-forked-proposals')
    const sampler = builtinImplementation('task-sampler', 'dataset')
    expect(generator).toMatchObject({ package: 'dsh-plugin-refine/components', version: '2.0.0' })
    expect(generator.integrity).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(generator.integrity).not.toBe(sampler.integrity)
    expect(hitchCliImplementation()).toEqual({
      package: generator.package,
      version: generator.version,
      integrity: 'sha256:957f231b51d86aae28fc86933ce5aef00c4f26cdc67b0db030b6207dc1bbd593',
    })
    expect(stableLlmVerifierImplementation()).toMatchObject({ package: generator.package, version: generator.version })
  })
})
