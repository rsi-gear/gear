import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeDataset, projectDataset } from '../../src/search/dataset-projection.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { digestJson } from '../../src/state/digest.js'
import { materializeTrees, materializationPolicy } from '../../src/state/materialize-tree.js'
import { RefineStateStore } from '../../src/state/store.js'
import { standardSearchDataset } from '../helpers/standard-search-dataset.js'
import { evolutionSpec } from '../helpers/research-fixture.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: vi.fn(actual.copyFile), open: vi.fn(actual.open) }
})
const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const roots: string[] = []
beforeEach(() => { vi.mocked(fs.copyFile).mockReset().mockImplementation(nativeFs.copyFile); vi.mocked(fs.open).mockReset().mockImplementation(nativeFs.open) })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gear-storage-')); roots.push(root)
  const spec = evolutionSpec(), dataset = await standardSearchDataset(root, 2)
  await fs.mkdir(join(dataset.ref, 'task-0/empty'))
  await fs.writeFile(join(dataset.ref, 'task-0/run'), '#!/bin/sh\nexit 0\n', { mode: 0o751 })
  dataset.digest = await digestDatasetRef(dataset.ref)
  spec.datasets = { seed: dataset, heldOut: dataset }
  const description = await describeDataset(spec, 'seed', root)
  const lock = await new RefineStateStore(root).acquireRoundLock(), signal = new AbortController().signal
  const state = join(root, 'search')
  const project = (ids = ['task-0']) => projectDataset(description, ids, state, { lock, signal })
  return { root, description, state, lock, signal, project }
}
const failure = (code: string) => Object.assign(new Error(code), { code })

describe('dataset materialization', () => {
  it('matches legacy copy bytes, paths, executable modes, empty directories and digest in every mode', async () => {
    const f = await fixture(), ids = ['task-0', 'task-1']
    const expectedRef = join(f.state, 'datasets', digestJson({ source: f.description.sourceDigest, ids }).slice(7))
    const originalCopy = nativeFs.copyFile
    for (const mode of ['copy', 'require-clone', 'auto'] as const) {
      // Exercise a successful clone syscall deterministically even on CI where
      // Node/libuv lacks FICLONE. Native capability is tested separately below.
      if (mode === 'require-clone') vi.spyOn(fs, 'copyFile').mockImplementation((src, dst, flags) => originalCopy(src, dst, flags! & ~constants.COPYFILE_FICLONE_FORCE))
      if (mode === 'auto') vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, flags) => {
        if (flags! & constants.COPYFILE_FICLONE_FORCE) throw failure('EXDEV')
        return originalCopy(src, dst, flags)
      })
      const result = await projectDataset(f.description, ids, f.state, { lock: f.lock, signal: f.signal, policy: { mode } })
      expect(result.ref).toBe(expectedRef)
      const legacy = join(f.root, `legacy-${mode}`); await fs.mkdir(legacy)
      for (const id of ids) await fs.cp(join(f.description.root, id), join(legacy, id), { recursive: true })
      const { dataset_digest: ignored, ...base } = f.description.manifest
      const body = { ...base, tasks: base.tasks.filter(t => ids.includes(t.task_id)) }
      await fs.writeFile(join(legacy, 'benchmark.adapter.json'), `${JSON.stringify({ ...body, dataset_digest: digestJson(body) }, null, 2)}\n`)
      expect(result.digest).toBe(await digestDatasetRef(legacy))
      expect((await fs.stat(join(result.ref, 'task-0/run'))).mode & 0o111).toBe(0o111)
      expect(await fs.readdir(join(result.ref, 'task-0/empty'))).toEqual([])
      const sidecar = JSON.parse(await fs.readFile(join(f.state, 'materializations', `${basename(result.ref)}.json`), 'utf8'))
      expect(sidecar.report[mode === 'require-clone' ? 'clonedFiles' : 'copiedFiles']).toBeGreaterThan(0)
      if (mode === 'auto') expect(sidecar.report.fallbackReasons.EXDEV).toBe(sidecar.report.copiedFiles)
      await fs.rm(result.ref, { recursive: true }); vi.restoreAllMocks()
    }
  })

  it('keeps source and overlapping projections independent and detects tampering on reuse', async () => {
    const f = await fixture(), a = await f.project(), b = await f.project(['task-0', 'task-1'])
    const source = join(f.description.root, 'task-0/instruction.md'), original = await fs.readFile(source)
    const paths = [source, join(a.ref, 'task-0/instruction.md'), join(b.ref, 'task-0/instruction.md')]
    expect(new Set(await Promise.all(paths.map(async p => (await fs.stat(p)).ino))).size).toBe(3)
    await fs.writeFile(paths[1]!, 'changed A')
    expect(await fs.readFile(paths[0]!)).toEqual(original); expect(await fs.readFile(paths[2]!)).toEqual(original)
    await expect(f.project()).rejects.toThrow('prepared task content changed')
    await fs.writeFile(paths[2]!, 'changed B'); expect(await fs.readFile(source)).toEqual(original)
    await fs.writeFile(source, 'changed source'); expect(await fs.readFile(paths[1]!, 'utf8')).toBe('changed A')
    await expect(f.project()).rejects.toThrow('source dataset changed')
  })

  it.each(['missing-task', 'missing-manifest', 'empty', 'extra'])('preserves corrupted canonical: %s', async variant => {
    const f = await fixture(), a = await f.project()
    if (variant === 'empty') for (const entry of await fs.readdir(a.ref)) await fs.rm(join(a.ref, entry), { recursive: true })
    if (variant === 'missing-task') await fs.rm(join(a.ref, 'task-0/instruction.md'))
    if (variant === 'missing-manifest') await fs.rm(join(a.ref, 'benchmark.adapter.json'))
    if (variant === 'extra') await fs.writeFile(join(a.ref, 'extra'), '')
    const before = await digestDatasetRef(a.ref)
    await expect(f.project()).rejects.toThrow()
    expect(await digestDatasetRef(a.ref)).toBe(before)
    expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([basename(a.ref)])
  })

  it.each(['EACCES', 'ENOSPC', 'EIO', 'EINVAL', 'EEXIST'])('never masks %s as unsupported clone', async code => {
    const f = await fixture(), spy = vi.spyOn(fs, 'copyFile').mockRejectedValue(failure(code))
    await expect(f.project()).rejects.toThrow(code)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([])
  })

  it('enforces fallback and free-space budgets before ordinary writes', async () => {
    const f = await fixture()
    const spy = vi.spyOn(fs, 'copyFile').mockRejectedValue(failure('ENOTSUP'))
    await expect(projectDataset(f.description, ['task-0'], f.state, { lock: f.lock, signal: f.signal, policy: { mode: 'auto', maxFallbackBytes: 0 } })).rejects.toThrow('byte budget')
    expect(spy).toHaveBeenCalledTimes(1)
    await expect(projectDataset(f.description, ['task-0'], f.state, { lock: f.lock, signal: f.signal, policy: { mode: 'require-clone' } })).rejects.toThrow('ENOTSUP')
    spy.mockRestore()
    await expect(projectDataset(f.description, ['task-0'], f.state, { lock: f.lock, signal: f.signal, policy: { mode: 'copy', minFreeBytes: Number.MAX_SAFE_INTEGER } })).rejects.toThrow('free space')
    expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([])
  })

  it('settles an in-flight copy before abort cleanup and never publishes', async () => {
    const f = await fixture(), abort = new AbortController(), original = nativeFs.copyFile
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
    const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, flags) => { started.resolve(); await finish.promise; await original(src, dst, flags) })
    const result = projectDataset(f.description, ['task-0'], f.state, { lock: f.lock, signal: abort.signal })
    const failed = expect(result).rejects.toThrow('stop')
    await started.promise; abort.abort(new Error('stop')); finish.resolve(); await failed
    expect(spy).toHaveBeenCalledTimes(1); expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([])
  })

  it('detects source mutation after a copy and does not publish', async () => {
    const f = await fixture(), original = nativeFs.copyFile
    vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, flags) => { await original(src, dst, flags! & ~constants.COPYFILE_FICLONE_FORCE); await fs.writeFile(src, 'mutated') })
    await expect(f.project()).rejects.toThrow('source changed')
    expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([])
  })

  it('ordinary copy handles short writes, bounds reads and settles handles before aborted cleanup', async () => {
    const f = await fixture(), source = join(f.root, 'large'), destination = join(f.root, 'ordinary')
    await fs.mkdir(source); const bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 37); await fs.writeFile(join(source, 'data'), bytes)
    const writes: number[] = [], reads: number[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await nativeFs.open(...args)
      if (args[1] === 'r') {
        const read = handle.read.bind(handle)
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          reads.push(length); return read(buffer, offset, length, position)
        }) as typeof handle.read
      } else {
        const write = handle.write.bind(handle)
        handle.write = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          writes.push(length); return write(buffer, offset, Math.min(length, 127_003), position)
        }) as typeof handle.write
      }
      return handle
    })
    const report = await materializeTrees([{ source, destination }], { signal: f.signal, policy: { mode: 'copy' } })
    expect(await fs.readFile(join(destination, 'data'))).toEqual(bytes)
    expect(Math.max(...reads)).toBeLessThanOrEqual(1024 * 1024); expect(writes.length).toBeGreaterThan(3)
    expect(fs.copyFile).not.toHaveBeenCalled(); expect(report.copiedLogicalBytes).toBe(bytes.length)

    const abort = new AbortController(), handles: fs.FileHandle[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await nativeFs.open(...args); handles.push(handle)
      if (args[1] === 'wx') {
        const write = handle.write.bind(handle)
        handle.write = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await write(buffer, offset, 1, position); abort.abort(new Error('stop copy')); return result
        }) as typeof handle.write
      }
      return handle
    })
    await expect(projectDataset(f.description, ['task-0'], f.state, { lock: f.lock, signal: abort.signal, policy: { mode: 'copy' } })).rejects.toThrow('stop copy')
    expect(handles.every(handle => handle.fd === -1)).toBe(true)
    expect(await fs.readdir(join(f.state, 'datasets'))).toEqual([])
  })

  it('rejects symlinks before any copy and requires a live lock', async () => {
    const f = await fixture()
    await fs.symlink(join(f.description.root, 'task-1'), join(f.description.root, 'task-0/link'))
    const spy = vi.spyOn(fs, 'copyFile')
    await expect(materializeTrees([{ source: join(f.description.root, 'task-0'), destination: join(f.root, 'out') }], { signal: f.signal })).rejects.toThrow('symlink')
    expect(spy).not.toHaveBeenCalled()
    await f.lock.release(); await expect(f.project()).rejects.toThrow('lock')
  })

  it('validates host policies without accepting undeclared keys', () => {
    for (const value of [{ mode: 'bad' }, { mode: 'copy', maxFallbackBytes: -1 }, { mode: 'auto', minFreeBytes: 0.5 }, { mode: 'auto', extra: 1 }]) expect(() => materializationPolicy(value)).toThrow()
  })
})
