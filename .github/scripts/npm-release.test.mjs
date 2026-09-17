import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRelease, releaseMetadata } from './npm-release.mjs'

function fixture(version = '0.1.0') {
  const pkg = { name: 'rsi-gear', version, repository: { url: 'git+https://github.com/rsi-gear/gear.git' } }
  const lock = { name: pkg.name, version, packages: { '': { name: pkg.name, version } } }
  return { pkg, lock }
}

test('first publish uses latest and performs a read-only lookup of the exact version', async () => {
  const { pkg, lock } = fixture()
  const plan = await planRelease(pkg, lock, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/rsi-gear/0.1.0')
    assert.equal(options.signal.aborted, false)
    return new Response(null, { status: 404 })
  })
  assert.deepEqual(plan, { name: 'rsi-gear', version: '0.1.0', tag: 'latest', publish: true })
})

test('an existing version is skipped when CI or the release job is retried', async () => {
  const { pkg, lock } = fixture()
  const plan = await planRelease(pkg, lock, async () => Response.json({ name: pkg.name, version: pkg.version }))
  assert.equal(plan.publish, false)
})

test('prereleases go to next without changing latest', async () => {
  const { pkg, lock } = fixture('0.2.0-rc.1')
  const plan = await planRelease(pkg, lock, async () => new Response(null, { status: 404 }))
  assert.equal(plan.tag, 'next')
  assert.equal(plan.publish, true)
})

test('registry failures, authentication errors and malformed responses do not authorize publication', async () => {
  const { pkg, lock } = fixture()
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(planRelease(pkg, lock, async () => new Response(null, { status })), /lookup failed/)
  }
  await assert.rejects(planRelease(pkg, lock, async () => { throw new Error('network timeout') }), /network timeout/)
  await assert.rejects(planRelease(pkg, lock, async () => Response.json({})), /unexpected package/)
  await assert.rejects(planRelease(pkg, lock, async () => Response.json({ name: pkg.name, version: '9.0.0' })), /unexpected package/)
})

test('metadata rejects private packages, wrong repositories and noncanonical versions', () => {
  const { pkg, lock } = fixture()
  for (const version of ['v0.1.0', '01.1.0', '0.1', '0.1.0-01', '0.1.0\npublish=true', '0.1.0+build']) {
    assert.throws(() => releaseMetadata({ ...pkg, version }, lock), /canonical release version/)
  }
  assert.throws(() => releaseMetadata({ ...pkg, private: true }, lock), /public rsi-gear/)
  assert.throws(() => releaseMetadata({ ...pkg, name: 'other-package' }, lock), /public rsi-gear/)
  assert.throws(() => releaseMetadata({ ...pkg, repository: undefined }, lock), /repository.url/)
})

test('both lockfile version records must match before publishing', () => {
  const { pkg, lock } = fixture()
  assert.throws(() => releaseMetadata(pkg, { ...lock, version: '0.0.1' }), /matching names and versions/)
  assert.throws(() => releaseMetadata(pkg, { ...lock, packages: { '': { name: pkg.name, version: '0.0.1' } } }), /matching names and versions/)
  assert.throws(() => releaseMetadata(pkg, { ...lock, packages: {} }), /matching names and versions/)
})
