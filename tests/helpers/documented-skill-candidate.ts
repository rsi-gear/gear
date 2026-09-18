import { readFile } from 'node:fs/promises'

// Execute the guide's own fenced examples so authoring instructions cannot drift
// from the candidate checks or the locked DSH loader.
export async function documentedSkillCandidate(): Promise<Record<string, string>> {
  const guide = await readFile(new URL('../../skills/refine/references/dsh-target-harness.md', import.meta.url), 'utf8')
  const section = guide.split('## `skills/`:')[1]?.split('\n## ')[0]
  if (section === undefined) throw new Error('DSH skill authoring section is missing')
  const files: Record<string, string> = {}
  for (const match of section.matchAll(/`([^`\n]+)`:\n\n```(?:markdown|js|yaml)\n([\s\S]*?)```/gu)) {
    files[match[1]!] = match[2]!
  }
  return files
}

export async function documentedHarnessCandidate(): Promise<Record<string, string>> {
  const guide = await readFile(new URL('../../skills/refine/references/dsh-target-harness.md', import.meta.url), 'utf8')
  const files: Record<string, string> = {}
  for (const match of guide.matchAll(/`([^`\n]+)`:\n\n```(?:markdown|js|yaml)\n([\s\S]*?)```/gu)) {
    files[match[1]!] = match[2]!
  }
  for (const [heading, path] of [
    ['### `pre_action`:', 'plugins/pre-action.js'],
    ['### `post_action`:', 'plugins/post-action.js'],
    ['### `action_verifier`:', 'plugins/action-verifier.js'],
  ]) {
    const source = guide.split(heading!)[1]?.match(/```js\n([\s\S]*?)```/u)?.[1]
    if (source === undefined) throw new Error(`missing documented hook: ${heading}`)
    files[path!] = source
  }
  const preset = guide.split('## Complete small layout')[1]?.match(/```yaml\n([\s\S]*?)```/u)?.[1]
  if (preset === undefined) throw new Error('missing documented full preset')
  files['preset/agent.cordis.yml'] = `${preset}\n- id: target-post-action\n  name: ../plugins/post-action.js\n`
  return files
}
