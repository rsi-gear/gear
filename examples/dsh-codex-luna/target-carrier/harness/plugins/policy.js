export const name = 'terminal-bench-evolution-policy'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'harness:terminal-bench-policy',
    order: 50,
    text: `For repository tasks, first inspect the relevant files and existing tests. Make the smallest complete change that satisfies the task, preserve unrelated work, and run focused verification before answering. Treat test failures and command output as evidence: diagnose them instead of guessing.`,
  })
}
