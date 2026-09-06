import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestDatasetRef } from '../../src/state/dataset.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('workspace-relative dataset identity', () => {
  it('hashes the same local tree for relative and absolute references outside the process cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-dataset-'))
    roots.push(root)
    const dataset = join(root, 'seed')
    await mkdir(dataset)
    await writeFile(join(dataset, 'benchmark.adapter.json'), '{}')
    await writeFile(join(dataset, 'task.sh'), 'exit 0')
    const frozen = await digestDatasetRef('seed', root)
    expect(frozen).toBe(await digestDatasetRef(dataset))
    const other = join(root, 'other')
    await mkdir(other)
    expect(await digestDatasetRef('seed', other)).not.toBe(frozen)
    await chmod(join(dataset, 'task.sh'), 0o755)
    expect(await digestDatasetRef('seed', root)).not.toBe(frozen)
  })

  it('keeps opaque provider references stable and refuses missing absolute datasets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-dataset-'))
    roots.push(root)
    expect(await digestDatasetRef('provider:immutable-v1', root)).toBe(await digestDatasetRef('provider:immutable-v1'))
    await expect(digestDatasetRef(join(root, 'missing'))).rejects.toThrow('local dataset ref does not exist')
  })
})
