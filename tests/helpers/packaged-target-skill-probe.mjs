// Test-only observer loaded by the real Target CLI after its fixed carrier patch.
// Never import the Gear runtime checker or prepare its snapshot/module fallback.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'packaged-target-skill-probe'
export const inject = ['loader', 'targetHarness', 'agents', 'skills', 'tools', 'agentDefaultModel']

export function apply(ctx, config) {
  ctx.on('llm/stream', () => { throw new Error('MODEL_REQUEST_FORBIDDEN') })
  const errors = []
  const logger = ctx.logger
  logger.exporters.set(-1, { export(event) {
    if (event.type === 'error') errors.push(event.args.map(String).join(' '))
  } })
  const run = async () => {
    await ctx.loader.await()
    assert.equal(ctx.targetHarness.ref, config.candidateDigest)
    const handle = await ctx.agents.create({ sessionId: 'packaged-skill-smoke',
      meta: { cwd: process.cwd() }, agentOptions: ctx.agentDefaultModel.currentSelection() })
    const agent = handle.agent
    assert.notEqual(agent.session.header.cwd, process.env.DSH_REFINE_REPOSITORY)
    const catalog = await agent.ctx.get('skills').list({ cwd: agent.session.header.cwd })
    assert(catalog.some(skill => skill.name === 'verify-change' && skill.provider === 'filesystem'))
    const result = await agent.ctx.get('tools').execute({ name: 'skill', arguments: { name: 'verify-change' },
      agent, callId: 'packaged-native-skill', signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.name, 'verify-change')
    assert.equal(result.value.provider, 'filesystem')
    assert.equal(result.value.content, config.expectedBody)
    assert.equal(result.value.resourceBase.path, join(process.env.DSH_REFINE_REPOSITORY, 'harness/skills/verify-change'))
    assert(result.content.some(block => block.type === 'text' && block.text.includes(config.expectedBody)))
    assert.equal(globalThis.gearSmokeNetworkRequests, 0)
    // Stop the provider's tools/change observer before closing its live agent.
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-openai-codex')?.fiber?.dispose()
    await handle.dispose()
    assert.deepEqual(errors, [])
    await writeFile(config.reportPath, JSON.stringify({ candidateDigest: ctx.targetHarness.ref,
      provider: result.value.provider, discovered: true, nativeRead: true, sessionCwd: agent.session.header.cwd,
      networkRequests: globalThis.gearSmokeNetworkRequests }))
    logger.exporters.delete(-1)
    ctx.appExit(0)
  }
  run().catch(error => {
    process.stderr.write(`${error.stack}\n`)
    ctx.appExit(1)
  })
}
