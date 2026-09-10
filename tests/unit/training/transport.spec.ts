import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { ModelNodeTransport, nodeCommand, nodeEnvelope, syncContentGraph, validateNodeResponse } from '../../../src/training/transport.js'
import { TrainingContentStore } from '../../../src/training/store.js'
import { jsonProcess } from '../../../src/training/process.js'
import * as subprocess from '../../../src/training/process.js'
import { ProcessResponseError } from '../../../src/training/process.js'
import { episodeAddress, type RolloutIntent } from '../../../src/training/episodes.js'
import type { ContentRef, ModelNodeConnection, NodeIdentity } from '../../../src/training/types.js'

describe('model-node subprocess transport and streaming CAS', () => {
  let root: string, controller: TrainingContentStore, destination: TrainingContentStore, connection: ModelNodeConnection, transport: ModelNodeTransport
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-node-'))
    controller = new TrainingContentStore(join(root, 'controller')); destination = new TrainingContentStore(join(root, 'node-content'))
    const configPath = join(root, 'node.json')
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: 'remote-gpu', nodeRoot: join(root, 'node-state'), storeRoot: destination.root, jobConfigPath: join(root, 'job.json') }))
    connection = { transport: { type: 'local' }, workspace: root, python: ['env', `PYTHONPATH=${resolve('python')}`, 'python3'], configPath, gateway: { localPort: 31001, nodePort: 31002 } }
    const observation = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
    transport = new ModelNodeTransport(connection, { nodeId: observation.nodeId, generation: observation.generation })
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  it('retries an interrupted SSH read with the exact original envelope', async () => {
    const remote = new ModelNodeTransport({ ...connection, transport: { type: 'ssh', host: 'vast-debug' } }, transport.identity)
    const call = vi.spyOn(subprocess, 'jsonProcess').mockRejectedValueOnce(new ProcessResponseError('process-failed', 'SSH disconnected', 255))
      .mockImplementation(async (_command, _args, input) => {
        const envelope = input as ReturnType<typeof nodeEnvelope>
        return { schemaVersion: 2, requestId: envelope.requestId, inputDigest: envelope.inputDigest, node: envelope.node, result: { present: false } }
      })
    expect(await remote.call('cas.stat', { digest: digestJson('missing') })).toEqual({ present: false })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]![2]).toBe(call.mock.calls[0]![2])
    expect(call.mock.calls[1]![3]!).toBeLessThan(call.mock.calls[0]![3]!)
  })
  it('bounds failed read retries and leaves mutations and local failures to their owner', async () => {
    const call = vi.spyOn(subprocess, 'jsonProcess').mockRejectedValue(new ProcessResponseError('process-failed', 'SSH disconnected', 255))
    const remote = new ModelNodeTransport({ ...connection, transport: { type: 'ssh', host: 'vast-debug' } }, transport.identity)
    await expect(remote.call('training.inspect', {})).rejects.toMatchObject({ exitCode: 255 })
    expect(call).toHaveBeenCalledTimes(3); call.mockClear()
    await expect(remote.call('training.control', {})).rejects.toMatchObject({ exitCode: 255 })
    expect(call).toHaveBeenCalledTimes(1); call.mockClear()
    await expect(transport.call('cas.stat', {})).rejects.toMatchObject({ exitCode: 255 })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('does not retry malformed successful responses or a different node identity', async () => {
    const remote = new ModelNodeTransport({ ...connection, transport: { type: 'ssh', host: 'vast-debug' } }, transport.identity)
    const call = vi.spyOn(subprocess, 'jsonProcess').mockRejectedValueOnce(new ProcessResponseError('invalid-process-json', 'empty response', 0))
    await expect(remote.call('training.inspect', {})).rejects.toMatchObject({ code: 'invalid-process-json' })
    expect(call).toHaveBeenCalledTimes(1); call.mockClear()
    call.mockImplementation(async (_command, _args, input) => {
      const envelope = input as ReturnType<typeof nodeEnvelope>
      return { schemaVersion: 2, requestId: envelope.requestId, inputDigest: envelope.inputDigest,
        node: { ...envelope.node, generation: 'another-generation' }, result: {} }
    })
    await expect(remote.call('training.inspect', {})).rejects.toMatchObject({ code: 'node-response-drift' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('streams an object larger than the worker input envelope without JSON/base64', async () => {
    const block = Buffer.alloc(1024 * 1024, 7); const blocks = 257; const hash = createHash('sha256')
    for (let i = 0; i < blocks; i++) hash.update(block)
    const digest = `sha256:${hash.digest('hex')}`
    const ref: ContentRef = { uri: `cas:${digest}`, digest, mediaType: 'application/octet-stream' }
    async function* content() { for (let i = 0; i < blocks; i++) yield block }
    await controller.importStream(ref, blocks * block.length, content())
    await transport.upload(controller, ref)
    expect((await destination.verifyFile(ref)).size).toBe(257 * 1024 * 1024)
    const collected = new TrainingContentStore(join(root, 'collected'))
    await transport.download(collected, ref)
    expect((await collected.verifyFile(ref)).size).toBe(257 * 1024 * 1024)
  }, 60_000)
  it('collects every referenced dependency into a different controller CAS', async () => {
    const tensor = await destination.putBytes(Buffer.from('weights'), 'application/octet-stream')
    const manifest = await destination.putJson({ files: [{ contentRef: tensor }] })
    const checkpoint = await destination.putJson({ hfExportRef: manifest })
    await syncContentGraph(transport, controller, [checkpoint], 'download')
    expect(await controller.readJson(checkpoint)).toEqual({ hfExportRef: manifest })
    expect((await controller.readBytes(tensor)).toString()).toBe('weights')
    await syncContentGraph(transport, controller, [checkpoint], 'download')
  })
  it('rejects truncated streams and stale generations before publishing anything', async () => {
    const ref = await destination.putBytes(Buffer.from('committed'), 'application/octet-stream')
    async function* interrupted() { yield Buffer.from('comm'); throw new Error('connection lost') }
    await expect(controller.importStream(ref, 9, interrupted())).rejects.toThrow('connection lost')
    await expect(readFile(controller.path(ref.digest))).rejects.toMatchObject({ code: 'ENOENT' })
    const stale = new ModelNodeTransport(connection, { nodeId: 'remote-gpu', generation: 'previous-boot' })
    await expect(stale.call('cas.stat', { digest: ref.digest })).rejects.toMatchObject({ code: 'node-generation-drift' })
    await transport.download(controller, ref)
    expect((await controller.readBytes(ref)).toString()).toBe('committed')
  })
  it('quotes the remote shell command and verifies correlated response identity', () => {
    const remote = { ...connection, transport: { type: 'ssh' as const, host: 'vast-debug' }, configPath: "/workspace/a ' quoted/$config.json" }
    const command = nodeCommand(remote, 'rpc')
    expect(command.slice(0, 8)).toEqual(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'vast-debug'])
    expect(command[8]).toContain("'/workspace/a '\\'' quoted/$config.json'")
    expect(() => nodeCommand({ ...remote, transport: { type: 'ssh', host: '-oProxyCommand=bad' } }, 'rpc')).toThrow('Host alias')
    const envelope = nodeEnvelope(transport.identity, 'probe', {})
    expect(() => validateNodeResponse({ schemaVersion: 2, requestId: envelope.requestId, node: transport.identity, inputDigest: digestJson('changed'), result: {} }, envelope)).toThrow('response differs')
  })
  it('reconciles durable episode feedback through real node RPC processes and rejects client-declared release', async () => {
    const seeded = await jsonProcess(connection.python, ['-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from episode_fixture import EpisodeFixture
from gear_training.content import atomic_json, digest_bytes, digest_json
data = json.load(sys.stdin)
f = EpisodeFixture(data["root"])
f.config.update(jobsRoot=data["root"], slimePath="/unused", megatronPath="/unused", episodeTimeoutSeconds=10,
                node=data["node"], nodeRoot=str(Path(data["root"]) / "node-state"))
f.persist()
atomic_json(data["jobConfigPath"], f.config)
handle = {"schemaVersion": 1, "provider": "slime", "jobId": f.directory.name, "requestDigest": digest_json(f.request)}
atomic_json(f.directory / "identity.json", {"handle": handle, "keyDigest": digest_json("fixture")})
atomic_json(f.directory / "worker.json", {"incarnation": "incarnation-1", "pending": True})
atomic_json(f.directory / "status.json", {"schemaVersion": 1, "handle": handle, "execution": "running", "phase": "collecting",
    "committedUpdate": 0, "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0}, "resourcesReleased": False})
intent = f.publish(); refs = f.generate(intent); result = f.feedback(intent)
pending = f.publish(1)
context = f.ledger.bind_run(digest_bytes(pending["credential"].encode()), "runtime-1", "run_" + "f" * 32, pending["binding"]["bindingId"])
f.ledger.begin_request(context, "inflight-native", "input-digest", 16)
f.journal.acknowledge(f.address(pending), {"evalId": "eval_" + "f" * 32})
print(json.dumps({"handle": handle, "intent": intent, "result": result, "refs": refs, "pending": pending}))
f.close()
`, resolve('python/tests')], { root, node: transport.identity, jobConfigPath: join(root, 'job.json') }) as {
      handle: unknown; intent: RolloutIntent; result: { evalId: string }; refs: ContentRef[]; pending: RolloutIntent
    }
    const { handle, intent, result } = seeded, address = episodeAddress(intent)
    const listing = await transport.call('training.episodes.list', { handle, renew: true }) as { entries: unknown[] }
    expect(listing.entries).toHaveLength(2)
    expect(await transport.call('training.episodes.admit', { handle, address, result })).toEqual({ valid: true })
    expect(await transport.call('training.episodes.result', { handle, address, result })).toEqual({ accepted: true })
    const reconnected = new ModelNodeTransport(connection, transport.identity)
    expect(await reconnected.call('training.episodes.result', { handle, address, result })).toEqual({ accepted: true })
    await expect(reconnected.call('training.episodes.ack', { handle, address: { ...address, fencingToken: 'changed' }, ack: { evalId: result.evalId } })).rejects.toMatchObject({ code: 'episode-address-drift' })
    await syncContentGraph(reconnected, controller, seeded.refs, 'download')
    const receipt = await controller.readJson<{ outputTokenIdsRef: ContentRef }>(seeded.refs[0]!)
    expect(await controller.readJson(receipt.outputTokenIdsRef)).toEqual([3, 4])
    await expect(reconnected.call('training.episodes.result', { handle, address: episodeAddress(seeded.pending), confirmed_stopped: true,
      result: { schemaVersion: 2, outcome: 'cancelled', evalId: `eval_${'f'.repeat(32)}`, reason: 'cancelled' } })).rejects.toMatchObject({ code: 'generation-still-running' })
  }, 15_000)
})
