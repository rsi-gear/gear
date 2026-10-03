import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrainingScriptController, type ScriptControllerConfig, type ScriptStatus } from '../../../src/training/script-controller.js'
import { sealScriptSource } from '../../../src/training/script-source.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import type { ModelNodeConnection } from '../../../src/training/types.js'
import { deployment } from './placement-fixture.js'
import { trainingCommand } from '../../../src/training/cli.js'

const recipe = `from gear_training import TrainingLoop
from helper import increment
class Source:
    async def generate(self, ctx): return [ctx.checkpoint]
class Rollout:
    def execute(self, ctx, tasks): return tasks
class Builder:
    def build(self, ctx, trajectories): return trajectories[0]
class Updater:
    def update(self, ctx, dataset): return dataset + increment

def build_loop(config, runtime):
    assert config["rounds"] == 3
    assert runtime.workspace
    return TrainingLoop(Source(), Rollout(), Builder(), Updater())
`

describe('four-stage script controller with real Python worker', () => {
  let root: string, source: string, config: ScriptControllerConfig, controller: TrainingScriptController
  const active = new Set<string>()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-script-controller-')); source = join(root, 'recipe'); await mkdir(source)
    await writeFile(join(source, 'recipe.py'), recipe); await writeFile(join(source, 'helper.py'), 'increment = 2\n')
    const configPath = join(root, 'node.json')
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: 'cpu', nodeRoot: join(root, 'node'), storeRoot: join(root, 'node-cas'), jobConfigPath: join(root, 'unused-job.json') }))
    config = { schemaVersion: 1, kind: 'training-script-controller', storeRoot: join(root, 'controller'), node: {
      transport: { type: 'local' }, workspace: root, python: ['env', `PYTHONPATH=${resolve('python')}`, 'PYTHONDONTWRITEBYTECODE=1', process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'],
      configPath, gateway: { localPort: 31001, nodePort: 31001 },
    } }
    controller = new TrainingScriptController(config)
  })
  afterEach(async () => {
    for (const id of active) { try { await controller.control(id, 'pause'); await stopped(id) } catch {} }
    active.clear(); await rm(root, { recursive: true, force: true })
  })
  const spec = () => ({ schemaVersion: 1, kind: 'training-script', source: 'recipe', entrypoint: 'recipe:build_loop', config: { rounds: 3, initialCheckpoint: 0, parameters: {} } })
  async function stopped(id: string): Promise<ScriptStatus> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const status = await controller.inspect(id)
      if (!['running', 'pausing'].includes(status.execution) && status.resourcesReleased) return status
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('script worker did not stop')
  }
  it('runs four ordinary stages from a frozen multi-file source without any GRPO configuration', async () => {
    const id = await controller.create(spec(), root); active.add(id)
    await writeFile(join(source, 'helper.py'), 'raise RuntimeError("mutable developer file must not execute")\n')
    await controller.control(id)
    const status = await stopped(id)
    expect(status.execution).toBe('completed')
    expect(JSON.stringify(status.result)).toContain('6')
    expect((await controller.control(id)).execution).toBe('completed')
    const configFile = join(root, 'controller.json'); await writeFile(configFile, JSON.stringify(config))
    expect(await trainingCommand(['status', id, '--config', configFile])).toEqual(await controller.inspect(id))
  }, 30_000)
  it('returns Unicode checkpoint keys through the controller protocol', async () => {
    await writeFile(join(source, 'recipe.py'), recipe.replace('return dataset + increment', 'return {"总数": (dataset["总数"] if isinstance(dataset, dict) else dataset) + increment}'))
    const id = await controller.create(spec(), root); active.add(id)
    await controller.control(id)
    const status = await stopped(id)
    expect(status.execution).toBe('completed')
    expect(status.result).toMatchObject({ checkpoint: { 总数: 6 } })
  }, 30_000)
  it('cooperatively pauses a stage and resumes its same workspace, rejecting stale start intents', async () => {
    await writeFile(join(source, 'recipe.py'), recipe.replace('async def generate(self, ctx): return [ctx.checkpoint]', `async def generate(self, ctx):
        import asyncio
        marker = ctx.workspace / "entered"
        if ctx.round_index == 0 and not marker.exists():
            marker.write_text("once")
            from pathlib import Path
            Path(ctx.config.parameters["marker"]).write_text("ready")
            while True:
                runtime_holder.check_cancel()
                await asyncio.sleep(.02)
        return [ctx.checkpoint]`).replace('    assert config["rounds"] == 3', '    global runtime_holder\n    runtime_holder = runtime\n    assert config["rounds"] == 3'))
    const input = spec(); input.config.parameters = { marker: join(root, 'entered') }
    const id = await controller.create(input, root); active.add(id)
    const frozen = JSON.parse(await readFile(join(config.storeRoot, 'script-runs', id, 'state.json'), 'utf8'))
    await controller.control(id)
    const deadline = Date.now() + 10_000
    while (true) {
      try { await access(join(root, 'entered')); break } catch {
        if (Date.now() > deadline) throw new Error('stage did not enter')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    await controller.control(id, 'pause')
    expect((await stopped(id)).execution).toBe('paused')
    const transport = new ModelNodeTransport(config.node as ModelNodeConnection, frozen.node)
    await expect(transport.call('scripts.control', { request: frozen.request, idempotencyKey: frozen.key, intent: frozen.intent })).rejects.toMatchObject({ code: 'script-control-stale' })
    await controller.control(id, 'start')
    expect((await stopped(id)).execution).toBe('completed')
  }, 40_000)
  it('uses the existing v2 controller connection for ordinary scripts without native evaluation', async () => {
    const d = deployment('local', 'local'); d.nodes.gpu = config.node as ModelNodeConnection
    const v2 = { schemaVersion: 2, storeRoot: config.storeRoot, deployment: d, episodeTimeoutSeconds: 30,
      evaluationGateway: { localPort: 32000, nodePort: 32000 }, hitch: { python: ['unused-hitch-python'] } }
    const file = join(root, 'existing-controller.json'), input = join(root, 'script.json')
    await writeFile(file, JSON.stringify(v2)); await writeFile(input, JSON.stringify(spec()))
    const status = await trainingCommand(['run', input, '--config', file]) as ScriptStatus
    active.add(status.handle.jobId)
    expect(status.execution).toBe('completed')
    expect(await trainingCommand(['status', status.handle.jobId, '--config', file])).toEqual(status)
  }, 30_000)
  it('does not package symlinks or silently select an absent entrypoint', async () => {
    await symlink(join(source, 'helper.py'), join(source, 'linked.py'))
    await expect(sealScriptSource(controller.store, source, 'recipe:build_loop')).rejects.toMatchObject({ code: 'unsafe-script-source' })
    await rm(join(source, 'linked.py'))
    await expect(sealScriptSource(controller.store, source, 'missing:build_loop')).rejects.toMatchObject({ code: 'missing-script-entrypoint' })
  })
})
