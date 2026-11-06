import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assert, canonical, digest, sha, verify } from './contracts.mjs'

export async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
export async function optionalJson(path) { try { return await json(path) } catch (e) { if (e.code !== 'ENOENT') throw e; return null } }
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  const f = await open(temp, 'wx', 0o600)
  try { await f.writeFile(canonical(value) + '\n'); await f.sync() } finally { await f.close() }
  try { await rename(temp, path) } finally { await rm(temp, { force: true }) }
}
export async function locked(path, run) {
  await mkdir(dirname(path), { recursive: true })
  let f
  try { f = await open(path, 'wx', 0o600) }
  catch (e) { if (e.code !== 'EEXIST') throw e; throw new Error(`operation already locked: ${path}; inspect the owner before recovery`) }
  await f.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
  try { return await run() } finally { await f.close(); await rm(path) }
}
export class Store {
  constructor(root) { this.root = resolve(root) }
  objectPath(id) { assert(/^sha256:[a-f0-9]{64}$/.test(id), 'invalid object ID'); return join(this.root, 'objects', id.slice(7)) }
  async putBytes(bytes) {
    const id = sha(bytes), path = this.objectPath(id)
    await mkdir(dirname(path), { recursive: true })
    try { const f = await open(path, 'wx', 0o400); try { await f.writeFile(bytes); await f.sync() } finally { await f.close() } }
    catch (e) { if (e.code !== 'EEXIST') throw e; assert(sha(await this.bytes(id)) === id, 'corrupt existing object') }
    return id
  }
  async bytes(id) { const path = this.objectPath(id), s = await lstat(path); assert(s.isFile() && s.nlink === 1, 'invalid object file'); const bytes = await readFile(path); assert(sha(bytes) === id, 'object content changed'); return bytes }
  async put(value) { return this.putBytes(Buffer.from(canonical(value))) }
  async get(id) { return JSON.parse((await this.bytes(id)).toString('utf8')) }
  path(kind, id) { assert(/^[a-z-]+$/.test(kind) && /^[a-zA-Z0-9_-]+$/.test(id), 'unsafe state key'); return join(this.root, kind, id + '.json') }
  async save(kind, id, value) { await atomicJson(this.path(kind, id), value) }
  async load(kind, id) { return optionalJson(this.path(kind, id)) }
  async verifySources(checkpoint) {
    for (const solution of checkpoint.solutions) { verify(solution); for (const f of solution.files) assert((await this.bytes(f.digest)).length === f.bytes, 'source size mismatch') }
    for (const id of new Set(checkpoint.history.map(e => e.execution.oofDigest).filter(Boolean))) await this.bytes(id)
  }
  async advanceProject(projectId, expected, next, stage) {
    return locked(this.path('locks', projectId), async () => {
      const previous = await this.load('projects', projectId)
      if (previous?.checkpoint !== expected && previous?.stage) {
        const published = await this.get(previous.stage)
        if (published.planDigest === stage.planDigest && published.previous === expected && published.checkpointDigest === next.digest) return previous.checkpoint
      }
      assert((previous?.checkpoint ?? null) === expected, 'project checkpoint changed')
      await this.verifySources(next)
      const ref = await this.put(next)
      // Persist the immutable stage before the head. Retrying cannot double-charge its cost events.
      const event = { ...stage, previous: expected, checkpoint: ref, checkpointDigest: next.digest }
      const stageRef = await this.put(event)
      await this.save('projects', projectId, { checkpoint: ref, stage: stageRef, previousStage: previous?.stage ?? null })
      return ref
    })
  }
}
