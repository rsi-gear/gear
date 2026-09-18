import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'terminal-bench-evolution-policy'
export const inject = ['systemPrompt']

export async function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'harness:terminal-bench-policy',
    order: 50,
    text: `For repository tasks, first inspect the relevant files and existing tests. Make the smallest complete change that satisfies the task, preserve unrelated work, and run focused verification before answering. Treat test failures and command output as evidence: diagnose them instead of guessing.`,
  })

  const requestProcedureUrl = new URL('../workflows/structured-cli-requests.md', import.meta.url)
  const requestHelperUrl = new URL('../workflows/structured-cli-requests/request.py', import.meta.url)
  if (!(await readFile(requestProcedureUrl, 'utf8')).trim()) throw new Error('Structured request procedure is empty')
  if (!(await readFile(requestHelperUrl, 'utf8')).trim()) throw new Error('Structured request helper is empty')
  ctx.systemPrompt.section({
    name: 'harness:structured-cli-requests',
    order: 52,
    text: `When a CLI tool takes JSON containing nested JSON strings, multiline/quoted text, or base64url fields, read the structured CLI requests procedure before composing that request:
${fileURLToPath(requestProcedureUrl)}
Use its helper to serialize the reviewed arguments and carry encoded values directly into the existing adapter call. Reuse the procedure once read. Native tools with structured arguments need no wrapper.
Request helper: ${fileURLToPath(requestHelperUrl)}`,
  })

  const workflowUrl = new URL('../workflows/source-backed-operations.md', import.meta.url)
  const workflowText = (await readFile(workflowUrl, 'utf8')).trim()
  if (!workflowText) throw new Error('Source-backed operations workflow is empty')

  const discoveryUrl = new URL('../workflows/resolve-workflow-sources.md', import.meta.url)
  const discoveryText = (await readFile(discoveryUrl, 'utf8')).trim()
  if (!discoveryText) throw new Error('Workflow source discovery procedure is empty')

  ctx.systemPrompt.section({
    name: 'harness:source-backed-operations',
    order: 51,
    text: `Available workflow: source-backed operations.
For operational tasks that reference a current SOP, latest guidance, reporting requirements, or a prior format, or require selecting business records and acting across app destinations, read the full procedure with the read tool before the first operational write:
${fileURLToPath(workflowUrl)}
It provides a source map, workflow contract, record/action ledger, and delivery reconciliation. Reuse it once read in the current task. Simple actions with fully specified inputs and ordinary repository work do not need this procedure.
Available subprocedure: resolve workflow sources. When the procedure, prior format, or existing destination remains unresolved (including when only an amendment is found), read this on-demand procedure:
${fileURLToPath(discoveryUrl)}
Reuse it once read; stop discovery when the needed sources are resolved.`,
  })
}
