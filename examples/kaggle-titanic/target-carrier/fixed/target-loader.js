import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { verifyHarness } from './integrity.mjs'

export const name = 'gear-kaggle-target-loader'
export const inject = ['tools', 'systemPrompt']

export function pipelineTool(execute) {
  const tool = defineTool({
    name: 'run_pipeline',
    description: 'Run the sealed Titanic pipeline once with the fixed task inputs. Takes no parameters. Report the returned status without trying another execution.',
    parameters: {},
    timeoutMs: 3_610_000,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (Object.keys(args).length) throw new Error('run_pipeline takes no arguments')
      return execute(exec)
    },
  })
  // defineTool's implicit parameter map is open; close the advertised schema
  // as well as checking at the execution boundary above.
  tool.parameters.additionalProperties = false
  return tool
}

export function installToolBoundary(ctx) {
  // A catalog mask alone is not authority: keep the global monotonic guard,
  // including for any future scoped/local tool registration.
  ctx.tools.guard(exec => exec.name === 'run_pipeline' ? undefined : 'This carrier only authorizes run_pipeline.')
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['run_pipeline'] })
  })
}

export async function apply(ctx, config) {
  const repository = resolve(config.repositoryRoot)
  const verified = await verifyHarness(repository)
  const artifactPath = '/opt/hitch-harness-artifact/artifact.json'
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
  if (artifact.harness_id !== 'deepseek' || artifact.source_type !== 'git') throw new Error('Kaggle carrier requires Hitch exact Git artifact')
  let called = false
  ctx.tools.register(pipelineTool(async exec => {
      if (called) throw new Error('pipeline already invoked for this task')
      called = true
      await verifyHarness(repository)
      return new Promise((accept, reject) => {
        const python = ['/usr/local/bin/python3', '/usr/bin/python3'].find(path => existsSync(path))
        if (!python) { reject(new Error('trusted Python interpreter is unavailable')); return }
        const child = spawn(python, ['-I', '-B', join(repository, 'fixed/runner.py'), '--repository', repository,
          '--artifact', artifactPath], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks = []; let bytes = 0; let stderr = ''; let killTimer
        const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 7000) }
        exec.signal.addEventListener('abort', abort, { once: true })
        if (exec.signal.aborted) abort()
        child.stdout.on('data', data => { bytes += data.length; if (bytes > 65536) abort(); else chunks.push(data) })
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192) })
        child.once('error', reject)
        child.once('close', (code, signal) => {
          exec.signal.removeEventListener('abort', abort)
          clearTimeout(killTimer)
          if (exec.signal.aborted) reject(exec.signal.reason ?? new Error('pipeline cancelled'))
          else if (code !== 0 || bytes > 65536) reject(new Error(`trusted runner failed (${signal ?? code}): ${stderr}`))
          else accept(Buffer.concat(chunks).toString('utf8').trim())
        })
      })
  }))
  installToolBoundary(ctx)
  ctx.systemPrompt.section({ name: 'kaggle:fixed-execution', order: 50,
    text: 'Call run_pipeline exactly once with {}. The fixed tool trains and predicts using the sealed candidate and the current task data. You cannot edit code or choose paths. After the result, report its status and finish.' })
  ctx.provide('targetHarness', Object.freeze({ ref: verified.manifest.digest, root: verified.root }))
}
