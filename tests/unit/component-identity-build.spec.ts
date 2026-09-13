import { execFile } from 'node:child_process'
import { cp, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  builtinImplementation,
  hitchCliImplementation,
  stableLlmVerifierImplementation,
} from '../../src/evolution/component-identity.js'
import type { ComponentKind } from '../../src/types.js'

const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
const TSC = join(PROJECT, 'node_modules/typescript/bin/tsc')
const roots: string[] = []

interface IdentityApi {
  builtinImplementation: typeof builtinImplementation
  hitchCliImplementation: typeof hitchCliImplementation
  stableLlmVerifierImplementation: typeof stableLlmVerifierImplementation
}

const sourceApi: IdentityApi = { builtinImplementation, hitchCliImplementation, stableLlmVerifierImplementation }
const builtins = [
  ['generator-dsh', 'candidate-generator', 'dsh-meta-forked-proposals'],
  ['generator', 'candidate-generator', 'meta-forked-proposals'],
  ['sampler', 'task-sampler', 'dataset'],
  ['assessor', 'candidate-assessor', 'evaluation-metrics'],
  ['selector', 'candidate-selector', 'highest-quality'],
  ['judge', 'judge', 'task-reward'],
  ['promotion', 'promotion-policy', 'paired-gate'],
] as const

function allIdentities(api: IdentityApi): Record<string, ReturnType<typeof builtinImplementation>> {
  return Object.fromEntries([
    ...builtins.map(([name, kind, id]) => [name, api.builtinImplementation(kind as ComponentKind, id)]),
    ['hitch', api.hitchCliImplementation()],
    ['llm', api.stableLlmVerifierImplementation()],
  ])
}

function representatives(api: IdentityApi) {
  const all = allIdentities(api)
  return { generator: all.generator, sampler: all.sampler, hitch: all.hitch, llm: all.llm }
}

async function packageCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gear-component-build-'))
  roots.push(root)
  await Promise.all([
    cp(join(PROJECT, 'src'), join(root, 'src'), { recursive: true }),
    cp(join(PROJECT, 'assets'), join(root, 'assets'), { recursive: true }),
    copyFile(join(PROJECT, 'package.json'), join(root, 'package.json')),
    copyFile(join(PROJECT, 'tsconfig.json'), join(root, 'tsconfig.json')),
    copyFile(join(PROJECT, 'tsconfig.build.json'), join(root, 'tsconfig.build.json')),
    symlink(join(PROJECT, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
  ])
  return root
}

async function compile(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: root }, (error, stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`isolated tsconfig.build compilation failed\n${stdout}${stderr}`, { cause: error }))
    })
  })
}

async function loadBuilt(root: string): Promise<IdentityApi> {
  return await import(`${pathToFileURL(join(root, 'lib/evolution/component-identity.js')).href}?fixture=${roots.length}`) as IdentityApi
}

async function cloneBuiltPackage(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gear-component-package-'))
  roots.push(root)
  await Promise.all([
    cp(join(source, 'src'), join(root, 'src'), { recursive: true }),
    cp(join(source, 'lib'), join(root, 'lib'), { recursive: true }),
    cp(join(source, 'assets'), join(root, 'assets'), { recursive: true }),
    copyFile(join(source, 'package.json'), join(root, 'package.json')),
    symlink(join(PROJECT, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
  ])
  return root
}

let builtRoot: string
let builtApi: IdentityApi

beforeAll(async () => {
  builtRoot = await packageCopy()
  await compile(builtRoot)
  builtApi = await loadBuilt(builtRoot)
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('component identity across formal builds', () => {
  it('gives all nine built-ins identical source and tsconfig.build identities', () => {
    expect(allIdentities(builtApi)).toEqual(allIdentities(sourceApi))
  })

  it('ignores publishing metadata in an independent built package copy', async () => {
    const root = await cloneBuiltPackage(builtRoot)
    const path = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({
      ...manifest,
      version: '99.88.77',
      description: 'changed publishing metadata',
      scripts: { arbitrary: 'true' },
      bin: { changed: './lib/changed.js' },
      exports: { '.': './lib/changed.js' },
      files: ['different/**'],
    }, null, 2)}\n`)

    expect(representatives(await loadBuilt(root))).toEqual(representatives(sourceApi))
  })

  it('changes only generator identity when its parent round-robin expression changes', async () => {
    const root = await packageCopy()
    const path = join(root, 'src/evolution/builtin-algorithms.ts')
    const source = await readFile(path, 'utf8')
    const before = 'ordered[index % ordered.length]!'
    const after = 'ordered[Math.min(index, ordered.length - 1)]!'
    expect(source.split(before).length - 1).toBe(2)
    const changed = source.replaceAll(before, after)
    expect(changed.split(after).length - 1).toBe(2)
    await writeFile(path, changed)
    await compile(root)

    const actual = allIdentities(await loadBuilt(root))
    const expected = allIdentities(sourceApi)
    expect(actual.generator).not.toEqual(expected.generator)
    expect(actual['generator-dsh']).not.toEqual(expected['generator-dsh'])
    const unchanged = Object.keys(expected).filter(name => !name.startsWith('generator'))
    expect(Object.fromEntries(unchanged.map(name => [name, actual[name]])))
      .toEqual(Object.fromEntries(unchanged.map(name => [name, expected[name]])))
  })

  it('excludes only the read-only verifier page method from Hitch rollout identity', async () => {
    const root = await packageCopy()
    const path = join(root, 'src/evaluator/hitch-cli.ts')
    const source = await readFile(path, 'utf8')
    const changed = source.replace(
      'Hitch verifier diagnostic capability schema is invalid',
      'Hitch verifier diagnostic capability contract is invalid',
    )
    expect(changed).not.toBe(source)
    await writeFile(path, changed)
    await compile(root)
    expect((await loadBuilt(root)).hitchCliImplementation()).toEqual(sourceApi.hitchCliImplementation())
  })

  it.each([
    ['evaluate', (source: string) => source.replace(
      'Hitch daemon evaluation requires a durable reservation',
      'Hitch daemon evaluation requires a durable owned reservation',
    )],
    ['evaluation helper', (source: string) => source.replace("'--max-concurrent'", "'--parallelism'")],
    ['evaluation call to diagnostic reader', (source: string) => source.replace(
      '    try {\n      this.assertEvaluationRequest(round, request)',
      '    try {\n      void this.inspectVerifierDiagnosticPage\n      this.assertEvaluationRequest(round, request)',
    )],
  ] as const)('changes Hitch rollout identity for an %s mutation', async (_label, mutate) => {
    const root = await packageCopy()
    const path = join(root, 'src/evaluator/hitch-cli.ts')
    const source = await readFile(path, 'utf8')
    const changed = mutate(source)
    expect(changed).not.toBe(source)
    await writeFile(path, changed)
    await compile(root)
    expect((await loadBuilt(root)).hitchCliImplementation()).not.toEqual(sourceApi.hitchCliImplementation())
  })
})
