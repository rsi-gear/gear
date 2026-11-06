import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeTrees, materializationPolicy, removeOwnedTree, type MaterializationPolicy } from '../../src/state/materialize-tree.js'
import { digestDatasetRef } from '../../src/state/dataset.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, copyFile: vi.fn(actual.copyFile) }
})
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
beforeEach(() => { vi.mocked(fs.copyFile).mockReset().mockImplementation(native.copyFile) })
afterEach(async () => { for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true }) })
const failure = (code: string) => Object.assign(new Error(code), { code })

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gear-materialization-')); roots.push(root)
  const source = join(root, 'source'), destination = join(root, 'destination')
  await fs.mkdir(join(source, 'empty'), { recursive: true })
  await fs.writeFile(join(source, 'run'), '#!/bin/sh\nexit 0\n', { mode: 0o751 })
  const copy = (policy: MaterializationPolicy = { mode: 'copy' }, signal = new AbortController().signal) => materializeTrees([{ source, destination }], { policy, signal })
  return { root, source, destination, copy }
}

describe('production tree materialization', () => {
  it.each(['copy', 'require-clone', 'auto'] as const)('preserves bytes, modes and empty directories with %s', async mode => {
    const f = await fixture()
    if (mode === 'require-clone') vi.mocked(fs.copyFile).mockImplementation((source, destination, flags) => native.copyFile(source, destination, flags! & ~constants.COPYFILE_FICLONE_FORCE))
    if (mode === 'auto') vi.mocked(fs.copyFile).mockRejectedValue(failure('EXDEV'))
    const report = await f.copy({ mode })
    expect(await digestDatasetRef(f.destination)).toBe(await digestDatasetRef(f.source))
    expect((await fs.stat(join(f.destination, 'run'))).mode & 0o777).toBe(0o751)
    expect(await fs.readdir(join(f.destination, 'empty'))).toEqual([])
    expect(report[mode === 'require-clone' ? 'clonedFiles' : 'copiedFiles']).toBe(1)
    if (mode === 'auto') expect(report.fallbackReasons).toEqual({ EXDEV: 1 })
    expect((await fs.stat(join(f.destination, 'run'))).ino).not.toBe((await fs.stat(join(f.source, 'run'))).ino)
    await fs.writeFile(join(f.destination, 'run'), 'changed copy')
    expect(await fs.readFile(join(f.source, 'run'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  })

  it.each(['EACCES', 'ENOSPC', 'EIO', 'EINVAL', 'EEXIST'])('does not treat %s as unsupported cloning', async code => {
    const f = await fixture()
    vi.mocked(fs.copyFile).mockRejectedValue(failure(code))
    await expect(f.copy({ mode: 'auto' })).rejects.toThrow(code)
    await expect(fs.lstat(join(f.destination, 'run'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces required cloning, fallback byte limits and free-space reserve', async () => {
    const f = await fixture()
    vi.mocked(fs.copyFile).mockRejectedValue(failure('ENOTSUP'))
    for (const [policy, message] of [
      [{ mode: 'require-clone' }, 'ENOTSUP'],
      [{ mode: 'auto', maxFallbackBytes: 1 }, 'byte budget'],
      [{ mode: 'copy', minFreeBytes: Number.MAX_SAFE_INTEGER }, 'free space'],
    ] as const) {
      await expect(f.copy(policy)).rejects.toThrow(message)
      await removeOwnedTree(f.destination)
    }
  })

  it('refuses linked inputs before writing and cleanup never follows outside links', async () => {
    const f = await fixture(), outside = join(f.root, 'outside')
    await fs.writeFile(outside, 'preserve')
    await fs.symlink(outside, join(f.source, 'link'))
    await expect(f.copy()).rejects.toThrow('symlink or special file')
    await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await removeOwnedTree(f.source)
    expect(await fs.readFile(outside, 'utf8')).toBe('preserve')
  })

  it('detects input drift during a copy', async () => {
    const f = await fixture()
    vi.mocked(fs.copyFile).mockImplementation(async (source, destination, flags) => {
      await native.copyFile(source, destination, flags! & ~constants.COPYFILE_FICLONE_FORCE)
      await fs.writeFile(source, 'changed during copy')
    })
    await expect(f.copy({ mode: 'require-clone' })).rejects.toThrow('source changed')
  })

  it('rejects pre-aborted requests without creating a destination', async () => {
    const f = await fixture()
    await expect(f.copy({ mode: 'copy' }, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([{ mode: 'invalid' }, { mode: 'copy', maxFallbackBytes: -1 }, { mode: 'auto', unknown: true }])('validates policy %j', policy => {
    expect(() => materializationPolicy(policy)).toThrow()
  })
})
