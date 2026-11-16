import { readFileSync } from 'node:fs'

export const name = 'data-analysis-guidance'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'harness:data-analysis',
    order: 50,
    text: readFileSync(new URL('../prompts/target.md', import.meta.url), 'utf8'),
  })
}
