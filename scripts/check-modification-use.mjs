// Installed Python observer probe over synthetic pinned DSH sources; no model or daemon.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const { observeModificationUse } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/python/modification-use.js')).href)
const { nativeManifestDigest } = await import(pathToFileURL(join(packageRoot, 'lib/adapters/hitch/native-source.js')).href)
const { canonicalDigest } = await import(pathToFileURL(join(packageRoot, 'lib/domain/canonical.js')).href)
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'gear-modification-use-installed-'))
try {
  const runId = 'run_' + 'e'.repeat(32), runRoot = join(root, 'runs', runId)
  const target = join(root, 'target'), resource = 'skills/exact-read/SKILL.md'
  const body = '# 精确读取\nUse recorded evidence.', content = '---\nname: exact-read\ndescription: installed probe\n---\n' + body + '\n'
  await mkdir(join(target, 'skills/exact-read'), { recursive: true })
  await mkdir(join(runRoot, 'trajectory/provider'), { recursive: true })
  await writeFile(join(target, resource), content)
  const wrapped = '<skill_content name="exact-read">\n<skill_resources>\nResources\n</skill_resources>\n\n<skill_instructions>\n' + body + '\n</skill_instructions>\n</skill_content>'
  const sessions = [
    [{ type: 'session', version: 0, id: 'main', delegationDepth: 0 }],
    [{ type: 'session', version: 4, id: 'child', parentSession: 'main', delegationDepth: 1 },
      { type: 'tool/call', seq: 1, data: { callId: 'private-call', name: 'skill', arguments: { name: 'exact-read' } } },
      { type: 'tool/result', seq: 2, data: { message: { role: 'tool', toolCallId: 'private-call', source: { kind: 'tool', callId: 'private-call' }, content: [{ type: 'text', text: wrapped }], isError: false } } }],
  ]
  const files = []
  for (const [index, session] of sessions.entries()) {
    const path = 'trajectory/provider/' + (index ? 'deepseek-child-session-1.jsonl' : 'deepseek-session.jsonl')
    const raw = session.map(value => JSON.stringify(value)).join('\n') + '\n'
    await writeFile(join(runRoot, path), raw)
    files.push({ role: 'provider_events', path, media_type: 'application/x-ndjson', sha256: hash(raw), bytes: Buffer.byteLength(raw) })
  }
  await writeFile(join(runRoot, 'trajectory.ref.json'), JSON.stringify({ schema_version: '2', run_id: runId, provider: 'deepseek', fidelity: 'provider_native', provider_session_id: 'main', files }))
  const pin = await nativeManifestDigest(root, runId)
  assert.match(pin, /^sha256:[a-f0-9]{64}$/)
  const input = { root, target_root: target, adapter: 'dsh', changes: [{ path: resource, after: { digest: canonicalDigest(Buffer.from(content).toString('base64')), executable: false } }],
    trials: [{ task_id: 'seed', repetition: 0, source_ref: 'trajectory:' + 'a'.repeat(64), source: { run_id: runId, native_manifest_digest: pin, content_digest: null } }] }
  const read = values => observeModificationUse(values, new AbortController().signal)
  const first = await read(input)
  assert.equal(first.resources_complete, true)
  assert.equal(first.trials[0].status, 'observed')
  assert.equal(first.trials[0].source.coverage, 'listed-files-complete')
  const action = first.trials[0].artifacts[0].actions[0]
  assert.equal(action.session_id, 'child')
  assert.equal(action.call_id_digest, canonicalDigest('private-call'))
  assert(!JSON.stringify(first).includes(body))
  assert(!JSON.stringify(first).includes('private-call'))
  const exhausted = await read({ ...input, budget: { remaining_bytes: 0, remaining_runs: 0 } })
  assert.equal(exhausted.trials[0].status, 'unknown')
  assert.equal(exhausted.trials[0].source.reason, 'snapshot-run-limit')
  await writeFile(join(runRoot, files[1].path), '{}\n')
  const changed = await read(input)
  assert.equal(changed.trials[0].status, 'unknown')
  assert.equal(changed.trials[0].source.coverage, 'partial')
  console.log(JSON.stringify({ pinnedNativeSources: true, exactSkillBody: true, childSession: true, digestDriftRejected: true, exhaustedBudgetIsUnknown: true, rawContentExcluded: true, modelCalls: 0 }))
} finally { await rm(root, { recursive: true, force: true }) }
