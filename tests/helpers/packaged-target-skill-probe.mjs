// Test-only observer loaded by the real Target CLI after its fixed carrier patch.
// Never import the Gear runtime checker or prepare its snapshot/module fallback.
import assert from 'node:assert/strict'
import { realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    const carrier = createRequire(join(process.env.DSH_REFINE_REPOSITORY, 'package.json'))
    const dsh = createRequire(await realpath(carrier.resolve('@deepseek-ai/dsh/package.json')))
    const nativeImport = name => import(pathToFileURL(dsh.resolve(name)).href)
    const agentRuntime = await nativeImport('@deepseek-ai/dsh-agent')
    const { renderPrompt, renderContextSnapshot } = await nativeImport('@deepseek-ai/dsh-system-prompt')
    const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools')
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({ sessionId: 'packaged-skill-smoke',
      meta: { cwd: process.cwd() }, agentOptions: { provider: selection.provider, model: selection.model },
      setup: agentCtx => { agentRuntime.installModelSelection(agentCtx, { current: selection, assembled: undefined }) } })
    const agent = handle.agent
    assert.notEqual(agent.session.header.cwd, process.env.DSH_REFINE_REPOSITORY)
    const assembly = await agent.ctx.get('systemPrompt').assemble(agentRuntime.assembleContextFor(agent))
    const prompt = renderPrompt(assembly)
    const context = renderContextSnapshot(assembly)
    if (config.fullHarness) {
      assert(prompt.includes('## Verification policy'))
      assert(prompt.includes('## Diagnose and verify workflow'))
      assert(context.includes(`Task workspace: ${agent.session.header.cwd}`))
      assert(assembly.tools.some(tool => tool.name === 'summarize_checks'))
      const call = (name, args) => agent.ctx.get('tools').execute({ name, arguments: args, agent,
        callId: `packaged-${name}`, signal: new AbortController().signal })
      const summary = await call('summarize_checks', { results: [{ name: 'a', passed: true }, { name: 'b', passed: false }] })
      assert.equal(summary.isError, false)
      assert.deepEqual(summary.value, { passed: 1, failed: 1 })
      assert.deepEqual(summary.content, [{ type: 'text', text: '1 passed; 1 failed' }])
      assert.equal((await call('summarize_checks', { results: 'invalid' })).isError, true)
      // Shadow only the execution body in this Agent, keeping the documented
      // hooks and the native DSH validation/pre/post/result pipeline intact.
      let executions = 0
      await agent.ctx.plugin({ name: 'packaged-safe-bash', inject: ['tools'], apply(scoped) {
        scoped.tools.register(defineTool({ name: 'bash', description: 'Safe fixture; no shell execution.',
          parameters: { command: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
          execute: ({ command }) => { executions++; return command === 'pytest -q' ? 'no tests ran' : 'token sk-1234567890123456' },
        }))
      } })
      assert.equal((await call('bash', { command: 'git reset --hard' })).isError, true)
      assert.equal(executions, 0)
      assert.deepEqual((await call('bash', { command: 'echo token' })).content, [{ type: 'text', text: 'token [redacted]' }])
      const noTests = await call('bash', { command: 'pytest -q' })
      assert.equal(noTests.isError, true)
      assert(JSON.stringify(noTests.content).includes('did not exercise any tests'))
      assert.equal(executions, 2)
      // Native workflow execution with no agent() calls: exercises the real
      // worker, argument/result boundary and disposal without a model request.
      const workflow = await call('workflow', {
        meta: { name: 'gear-contract-smoke', description: 'Validate native workflow combinators without delegation.' },
        script: "phase('check'); const values = await parallel([async () => 1, async () => 2]); return { total: values.reduce((a,b) => a+b, 0) }",
      })
      assert.equal(workflow.isError, false, JSON.stringify(workflow.content))
      assert.equal(workflow.value.agentsStarted, 0)
      assert.deepEqual(workflow.value.result, { total: 3 })
    }
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
      promptAssembly: true, ...(config.fullHarness ? { customTool: true, hooks: true, workflow: true } : {}),
      networkRequests: globalThis.gearSmokeNetworkRequests }))
    logger.exporters.delete(-1)
    ctx.appExit(0)
  }
  run().catch(error => {
    process.stderr.write(`${error.stack}\n`)
    ctx.appExit(1)
  })
}
