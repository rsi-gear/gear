import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function isolatedIdentity() {
  const root = mkdtempSync(join(tmpdir(), 'gear-closure-snapshot-')); roots.push(root)
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/algorithm')
  const algorithm = join(root, 'src/algorithm'), data = join(algorithm, 'data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  for (const name of ['schema', 'data/identity']) {
    const output = ts.transpileModule(readFileSync(join(source, `${name}.ts`), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    writeFileSync(join(algorithm, `${name}.js`), output)
  }
  const fixture = join(algorithm, 'fixture.js'), other = join(algorithm, 'other.js')
  writeFileSync(fixture, 'export const version = 1\n')
  writeFileSync(other, 'export const other = true\n')
  const module = await import(pathToFileURL(join(data, 'identity.js')).href) as
    typeof import('../../src/algorithm/data/identity.js')
  return { module, fixture }
}

it('keeps digest bytes identical while isolating concurrent admission snapshots and later source changes', async () => {
  const { module, fixture } = await isolatedIdentity(), config = { host: 'test' }
  const direct = module.implementationClosureDigest(['fixture'], config)
  const bytes = readFileSync(fixture), closure = createHash('sha256')
    .update('src/algorithm/fixture.js').update('\0').update(String(bytes.length)).update('\0')
    .update(bytes).update('\0').digest('hex')
  const expected = createHash('sha256').update(JSON.stringify({ closure, configuration: config,
    node: process.versions.node })).digest('hex')
  expect(direct).toBe(expected)
  let signalCaptured!: () => void, releaseFirst!: () => void
  const captured = new Promise<void>(resolve => { signalCaptured = resolve })
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve })
  const first = module.withImplementationClosureSnapshot(async snapshot => {
    snapshot.capture(['fixture'])
    signalCaptured()
    await blocked
    const same = module.implementationClosureDigest(['fixture'], config)
    // A captured entrypoint cannot accidentally stand in for a different closure.
    expect(module.implementationClosureDigest(['other'], config)).not.toBe(same)
    return same
  })
  await captured
  writeFileSync(fixture, 'export const version = 2\n')
  const next = await module.withImplementationClosureSnapshot(async snapshot => {
    snapshot.capture(['fixture'])
    return module.implementationClosureDigest(['fixture'], config)
  })
  releaseFirst()
  expect(await first).toBe(direct)
  expect(next).not.toBe(direct)
  expect(module.implementationClosureDigest(['fixture'], config)).toBe(next)
})

it('invalidates an invocation snapshot for delayed callbacks', async () => {
  const { module, fixture } = await isolatedIdentity()
  let delayed!: Promise<unknown>
  let releaseCallback!: () => void
  const afterScope = new Promise<void>(resolve => { releaseCallback = resolve })
  await module.withImplementationClosureSnapshot(async snapshot => {
    snapshot.capture(['fixture'])
    delayed = new Promise(resolve => setTimeout(async () => {
      await afterScope
      try { resolve(snapshot.digest(['fixture'], {})) }
      catch (error) { resolve(error) }
    }, 0))
  })
  const before = module.implementationClosureDigest(['fixture'], {})
  writeFileSync(fixture, 'export const version = 3\n')
  releaseCallback()
  const lateResult = await delayed
  expect(lateResult).toBeInstanceOf(Error)
  expect((lateResult as Error).message).toContain('Implementation closure snapshot has expired')
  expect(module.implementationClosureDigest(['fixture'], {})).not.toBe(before)
})

it('shares observed bytes across overlapping entrypoints without changing their closure digests', async () => {
  const { module, fixture } = await isolatedIdentity(), directory = dirname(fixture)
  const other = join(directory, 'other.js'), shared = join(directory, 'shared.js')
  writeFileSync(fixture, "import './other.js'\nimport './shared.js'\nexport const version = 1\n")
  writeFileSync(other, "import './fixture.js'\nimport './shared.js'\nexport const other = true\n")
  writeFileSync(shared, 'export const shared = 1\n')
  const config = { purpose: 'shared-cache' }
  const expected = module.implementationClosureDigest(['fixture'], config)
  expect(module.implementationClosureDigest(['other'], config)).toBe(expected)
  await module.withImplementationClosureSnapshot(async snapshot => {
    snapshot.capture(['fixture'])
    writeFileSync(shared, 'export const shared = 2\n')
    snapshot.capture(['other'])
    expect(module.implementationClosureDigest(['fixture'], config)).toBe(expected)
    expect(module.implementationClosureDigest(['other'], config)).toBe(expected)
  })
  expect(module.implementationClosureDigest(['fixture'], config)).not.toBe(expected)
})

it('rejects an oversized external package while scanning its files', async () => {
  const { module, fixture } = await isolatedIdentity()
  const packageRoot = join(dirname(dirname(dirname(fixture))), 'node_modules', 'large-package')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"large-package","version":"1.0.0","main":"index.js"}')
  writeFileSync(join(packageRoot, 'index.js'), 'export const large = true\n')
  for (let index = 0; index < 10_001; index++)
    writeFileSync(join(packageRoot, `file-${index}`), '')
  writeFileSync(fixture, "import 'large-package'\n")
  await expect(module.withImplementationClosureSnapshot(async snapshot => { snapshot.capture(['fixture']) }))
    .rejects.toThrow('external dependency closure too large')
})
