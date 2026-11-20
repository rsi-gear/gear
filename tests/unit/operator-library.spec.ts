import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LibraryStore } from '../../src/adapters/storage/libraries.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperatorArtifact } from '../../src/domain/operator-run.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-library-'))
  roots.push(root)
  return new LibraryStore(root)
}
function snapshot(text: string, run = 'run'): OperatorArtifact {
  const value = { base: null, assets: {}, data: text },
    sources: [] = []
  return {
    ref: {
      run_id: run,
      kind: 'library',
      visibility: 'optimization',
      digest: canonicalDigest({ kind: 'library', value, sources }),
    },
    value,
    sources,
  }
}

it('recovers an original publication after receipt loss and a later head update', async () => {
  const store = await fixture(),
    a = snapshot('a'),
    b = snapshot('b')
  await store.save(a)
  await store.save(b)
  const request = {
    commit_id: canonicalDigest('first'),
    name: 'skills',
    snapshot: a.ref,
    expected_revision: null,
  }
  const first = await store.publish(request)
  await unlink(join(store.root, 'commits', request.commit_id.slice(7) + '.json'))
  const second = await store.publish({
    ...request,
    commit_id: canonicalDigest('second'),
    snapshot: b.ref,
    expected_revision: first.revision,
  })
  expect(second.status).toBe('published')
  const reopened = new LibraryStore(store.root)
  expect(await reopened.publish(request)).toEqual(first)
  expect(await reopened.head('skills')).toEqual({ revision: second.revision, snapshot: b.ref })
  await expect(reopened.publish({ ...request, snapshot: b.ref })).rejects.toMatchObject({
    code: 'library-commit-conflict',
  })
})

it('serializes competing CAS requests and preserves a conflict across subsequent head updates', async () => {
  const store = await fixture(),
    a = snapshot('a')
  await store.save(a)
  const requests = ['left', 'right'].map((id) => ({
    name: 'skills',
    snapshot: a.ref,
    commit_id: canonicalDigest(id),
    expected_revision: null,
  }))
  const results = await Promise.all(requests.map((request) => store.publish(request)))
  expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'published'])
  const conflict = results.findIndex((result) => result.status === 'conflict')
  const head = await store.head('skills')
  await store.publish({
    ...requests[0]!,
    commit_id: canonicalDigest('next'),
    expected_revision: head!.revision,
  })
  expect(await store.publish(requests[conflict]!)).toEqual(results[conflict])
})

it('keeps identical content under distinct owner references and rejects forged snapshots', async () => {
  const store = await fixture(),
    a = snapshot('same', 'first'),
    b = snapshot('same', 'second')
  await store.save(a)
  await store.save(b)
  expect(a.ref.digest).toBe(b.ref.digest)
  expect(await store.snapshot(a.ref)).toEqual(a)
  expect(await store.snapshot(b.ref)).toEqual(b)
  await expect(store.save({ ...a, value: 'changed' })).rejects.toMatchObject({
    code: 'library-snapshot-identity',
  })
})
