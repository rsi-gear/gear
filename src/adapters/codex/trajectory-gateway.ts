import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExperienceSnapshot } from '../../domain/experience.js'
import type { ArtifactReaderDescriptor } from '../../domain/trajectory.js'
import { GearError } from '../../domain/errors.js'
import { readSeedTrajectory } from '../artifacts/access.js'
import { RefineSkillServer } from '../skill/server.js'
import { publishFile } from '../storage/atomic.js'

/** A bounded per-operation transport that needs no socket creation inside Linux seccomp. */
export async function trajectoryMailbox(root: string, call: (params: unknown) => Promise<unknown>) {
  const requests = join(root, 'trajectory-requests'),
    responses = join(root, 'trajectory-responses')
  for (const path of [requests, responses]) await mkdir(path, { mode: 0o700 })
  const seen = new Set<string>(),
    pending = new Set<Promise<void>>()
  let closed = false,
    scanning: Promise<void> | undefined
  async function handle(name: string) {
    const id = name.slice(0, -5)
    let response: unknown
    try {
      const file = await open(
        join(requests, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size > 32768) throw new Error('invalid request file')
        const buffer = Buffer.alloc(32769),
          { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 32768) throw new Error('request exceeds its bound')
        const request = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Record<string, unknown>
        if (!request || request.id !== id || request.method !== 'trajectory.read')
          throw new Error('invalid request')
        response = { id, result: await call(request.params) }
        if (Buffer.byteLength(JSON.stringify(response)) > 70 * 1024)
          throw new Error('reply exceeds its bound')
      } finally {
        await file.close()
      }
    } catch (error) {
      response = {
        id,
        error: { code: error instanceof GearError ? error.code : 'trajectory-request-invalid' },
      }
    }
    await publishFile(join(responses, name), JSON.stringify(response), { immutable: true })
  }
  async function scan() {
    for (const name of await readdir(requests)) {
      if (closed || pending.size >= 4 || seen.size >= 256) break
      if (!/^[a-f0-9]{32}\.json$/u.test(name) || seen.has(name)) continue
      seen.add(name)
      const task = handle(name)
        .catch(() => {})
        .finally(() => {
          pending.delete(task)
        })
      pending.add(task)
    }
  }
  const timer = setInterval(() => {
    if (!closed && !scanning)
      scanning = scan()
        .catch(() => {})
        .finally(() => {
          scanning = undefined
        })
  }, 25)
  timer.unref()
  return {
    requests,
    responses,
    async dispose() {
      closed = true
      clearInterval(timer)
      await scanning
      await Promise.all(pending)
    },
  }
}

/** A per-operation read capability. No project/controller methods are reachable. */
export async function trajectoryGateway(
  root: string,
  runRoot: string,
  snapshot: ExperienceSnapshot,
  descriptor: ArtifactReaderDescriptor,
  python: string,
  registerDispose?: (dispose: () => Promise<void>) => void,
) {
  const socket = join(root, 't.sock'),
    token = randomUUID(),
    abort = new AbortController()
  let active = 0,
    used = 0
  const call = async (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new GearError(
        'trajectory-access-denied',
        'Only the frozen trajectory read capability is available',
      )
    const { token: supplied, ...params } = input as Record<string, unknown>
    if (supplied !== token) throw new GearError('trajectory-access-denied', 'Invalid operation capability')
    if (active >= 4 || used >= 256)
      throw new GearError('trajectory-read-limit', 'Operation trajectory read limit reached')
    active++
    used++
    try {
      return await readSeedTrajectory(runRoot, snapshot, descriptor, params, abort.signal, python)
    } catch (error) {
      throw new GearError(
        error instanceof GearError ? error.code : 'trajectory-read-failed',
        'The authorized trajectory could not be read; check its reference, query and source integrity',
      )
    } finally {
      active--
    }
  }
  const mailbox = process.platform === 'linux' ? await trajectoryMailbox(root, call) : undefined
  const server = mailbox
    ? undefined
    : new RefineSkillServer(socket, {
        maxRequestBytes: 32768,
        async call(method, input) {
          if (method !== 'trajectory.read')
            throw new GearError('trajectory-access-denied', 'Only trajectory reads are allowed')
          return call(input)
        },
      })
  const dispose = async () => {
    abort.abort(new GearError('trajectory-reader-stopped', 'Meta operation finished'))
    await server?.dispose()
    await mailbox?.dispose()
  }
  // Register before writing capability metadata or starting the socket can fail.
  registerDispose?.(dispose)
  await writeFile(
    join(root, 'experience/gateway.json'),
    JSON.stringify(
      mailbox ? { requests: mailbox.requests, responses: mailbox.responses, token } : { socket, token },
    ),
    { mode: 0o400 },
  )
  await server?.start()
  return {
    readPaths: mailbox ? [mailbox.requests, mailbox.responses] : [socket],
    writePaths: mailbox ? [mailbox.requests] : [],
    sockets: mailbox ? [] : [socket],
    path: join(root, 'experience/gateway.json'),
    dispose,
  }
}
