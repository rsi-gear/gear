import { defineTool } from '@deepseek-ai/dsh-tools'
import { Driver } from './driver.mjs'
import { installModelBudget } from './model-budget.mjs'
import { zeroCost } from './lib/contracts.mjs'
import { randomUUID } from 'node:crypto'

export const name = 'gear-analysis-target-loader'
export const inject = ['tools', 'systemPrompt', 'llm']
const string = { type: 'string', required: true }
export async function apply(ctx, config) {
  const driver = new Driver(config.repositoryRoot)
  await driver.initialize()
  if (driver.request.allowance.tokens !== null) {
    if (driver.request.model.startsWith('openai-codex/')) throw new Error('Codex does not support this hard model budget; select the explicit usage-only profile')
    const restore = installModelBudget(driver.budget, () => driver.persist())
    ctx.on('dispose', restore)
  } else {
    ctx.on('llm/stream', async function* (_options, next) {
      let usage = null
      try { for await (const chunk of next()) { if (chunk.type === 'usage') usage = chunk.usage; yield chunk } }
      finally {
        const tokens = usage ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0
        driver.budget.observeModel(`model-${randomUUID()}`, tokens, usage !== null)
        await driver.persist()
      }
    })
  }
  ctx.on('agent/turn-stopping', async () => { if (!driver.finished) await driver.closeIncomplete('agent stopped before rollout_finish') })
  const definitions = [
    ['task_inspect', 'Read the task, history, policy action and research guidance.', {}, (_, e) => driver.inspect(e.signal)],
    ['workspace_write', 'Write Python source or an analysis script. Use an empty expectedDigest for a new file.',
      { path: string, content: string, expectedDigest: string }, a => driver.write(a.path, a.content, a.expectedDigest || null)],
    ['workspace_read', 'Read workspace source, or a source file from a visible historical solution.',
      { path: string, solutionDigest: { type: 'string' } }, a => driver.read(a.path, a.solutionDigest ?? null)],
    ['workspace_list', 'List files in this rollout workspace.', {}, () => driver.list()],
    ['experiment_inspect', 'Read up to five authenticated experiment records; offset starts at zero.',
      { offset: { type: 'integer', required: true } }, a => driver.inspectExperiments(a.offset)],
    ['experiment_oof', 'Read up to 100 authenticated out-of-fold predictions from visible research history.',
      { experimentId: string, offset: { type: 'integer', required: true } }, a => driver.inspectOof(a.experimentId, a.offset)],
    ['experiment_reuse', 'Register a compatible historical solution as this rollout experiment, consuming its slot.',
      { solutionDigest: string, hypothesis: string }, a => driver.reuse(a.solutionDigest, a.hypothesis)],
    ['analysis_execute', 'Run a data-inspection script. Data is under /work/inputs; write outputs under /work/scratch. This is not an extra model validation.',
      { path: string }, (a, e) => driver.analyze(a.path, e.signal)],
    ['experiment_evaluate', 'Seal and evaluate exactly one solution with the locked five-fold plan. Failure consumes this rollout.',
      { entrypoint: string, hypothesis: string, intendedChange: string }, (a, e) => driver.evaluate(a, e.signal)],
    ['experiment_select', 'Run the sealed selection policy against compatible internal evidence.', {}, (_, e) => driver.select(e.signal)],
    ['solution_freeze', 'Read the immutable source manifest after evaluation or reuse.', {}, () => {
      if (!driver.solution) throw new Error('evaluate or reuse first'); return driver.solution
    }],
    ['rollout_finish', 'Seal this experiment and its interpretation for the next rollout.',
      { conclusion: string, limitations: { type: 'array', items: { type: 'string' }, required: true } }, a => driver.finish(a.conclusion, a.limitations)],
  ]
  const names = definitions.map(d => d[0]); let count = 0, queue = Promise.resolve()
  ctx.tools.guard(exec => names.includes(exec.name) && !driver.finished ? undefined : 'Only the active analysis rollout tools are authorized.')
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: names }) })
  for (const [name, description, parameters, execute] of definitions) {
    const tool = defineTool({ name, description, parameters, timeoutMs: 300000,
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
      execute(args, exec) {
        const task = queue.then(async () => {
          if (driver.finished) throw new Error('rollout already sealed')
          const id = `tool-${++count}`; driver.budget.reserve(id, { ...zeroCost(), tools: 1 }); driver.budget.settle(id)
          await driver.persist()
          let value
          try { value = await execute(args, exec) }
          catch (error) { if (error.code === 'POLICY_ERROR') value = await driver.failPolicy(error); else throw error }
          return JSON.stringify(value)
        })
        queue = task.catch(() => {}); return task
      } })
    tool.parameters.additionalProperties = false; ctx.tools.register(tool)
  }
  ctx.systemPrompt.section({ name: 'analysis:research', order: 50,
    text: 'Complete one data-analysis experiment. First call task_inspect and follow the returned research policy and instructions. Finish with experiment_select and rollout_finish; then give a brief final status.' })
  ctx.provide('targetHarness', Object.freeze({ ref: driver.harness.manifest.digest, root: driver.harness.root }))
}
