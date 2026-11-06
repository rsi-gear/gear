// Read-only real Hitch protocol probe over a temporary synthetic session; no model or daemon.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HitchArtifactReader } from '../lib/adapters/hitch/trajectory.js'
import { builtinPolicy } from '../lib/adapters/python/builtin-policy.js'
import { canonicalDigest } from '../lib/domain/canonical.js'

const root = await mkdtemp(join(tmpdir(), 'gear-trajectory-real-'))
const run = 'run_' + 'd'.repeat(32), runRoot = join(root, 'runs', run), path = join(runRoot, 'session.jsonl')
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
try {
  await mkdir(runRoot, { recursive: true })
  const time = 1800000000000, longText = '历史轨迹内容'.repeat(6000)
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: { id: 'user', role: 'user', content: [{ type: 'text', text: longText }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'request/header', data: { header: { config: { provider: 'test', model: 'synthetic' }, system: 'local probe' }, reason: 'initial' } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'test', model: 'synthetic' } } }, surfaceOp: 'append', sourceEventSeqs: [] },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: time + seq }))
  const raw = [{ type: 'session', version: 0, id: run, createdAt: time, delegationDepth: 0 }, ...events].map(value => JSON.stringify(value)).join('\n') + '\n'
  await writeFile(path, raw)
  await writeFile(join(runRoot, 'trajectory.ref.json'), JSON.stringify({ schema_version: '2', run_id: run, fidelity: 'normalized', provider: 'deepseek', files: [{ role: 'canonical_session', path: 'session.jsonl', media_type: 'application/x-ndjson', sha256: hash(raw), bytes: Buffer.byteLength(raw) }] }))
  const reader = new HitchArtifactReader(process.env.GEAR_TEST_HITCH ?? 'hitch', root)
  const source = await reader.capture(run, 'seed', 0, signal())
  assert.equal(source.status, 'available', 'The configured Hitch must support canonical trajectory events')
  assert.equal(source.content_digest, hash(raw))
  const binding = { snapshot_digest: canonicalDigest('snapshot'), source_ref: 'trajectory:' + 'a'.repeat(64), content_digest: source.content_digest }
  let cursor, seen = []
  do {
    const query = builtinPolicy('trajectory_query', { ...binding, query: { limit: 2, ...(cursor ? { cursor } : {}) } })
    const rawPage = await reader.read(source, { ...query.filter, limit: query.limit, ...(query.provider_cursor ? { cursor: query.provider_cursor } : {}) }, signal())
    const page = builtinPolicy('trajectory_page', { query, page: rawPage })
    assert.equal(page.child_sessions, 'not-included')
    assert(Buffer.byteLength(JSON.stringify(page)) <= 65536)
    seen.push(...page.items.map(item => item.seq)); cursor = page.next_cursor
  } while (cursor)
  assert.deepEqual(seen, events.map(event => event.seq))
  const detail = await reader.read(source, { seq_start: 2, seq_end: 2, field: 'message.content.0.text', limit: 1 }, signal())
  assert.equal(detail.events[0].value.truncated, true)
  assert.equal(detail.events[0].value.sha256, hash(longText))
  assert.equal(detail.events[0].value.source.run_id, run)
  assert.equal(detail.events[0].value.source.seq, 2)
  const filtered = await reader.read(source, { types: ['assistant/message'], limit: 1 }, signal())
  assert.equal(filtered.total_matches, 1)
  assert.equal(filtered.events[0].seq, 4)
  await writeFile(path, raw.replace('answer', 'change'))
  await assert.rejects(reader.read(source, {}, signal()))
  await writeFile(path, raw)
  await rename(path, path + '.original'); await symlink(path + '.original', path)
  await assert.rejects(reader.read(source, {}, signal()))
  console.log(JSON.stringify({ realHitch: true, syntheticCanonicalSession: true, boundedPages: true, exactFieldExcerpt: true, digestDriftRejected: true, symlinkRejected: true, modelCalls: 0 }))
} finally { await rm(root, { recursive: true, force: true }) }
