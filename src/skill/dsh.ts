import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { load } from 'js-yaml'
import type { SkillHarnessIdentity } from '../meta/skill.js'
import type { RefineSkillGateway } from './gateway.js'

const BUNDLED_SKILL_PROVIDER = 'gear-refine-bundled'
const BUNDLED_SKILL_URL = new URL('../../skills/refine/SKILL.md', import.meta.url)
const BUNDLED_SKILL_ROOT = fileURLToPath(new URL('../../skills/refine/', import.meta.url))

export interface BundledRefineSkill {
  name: string
  description: string
  content: string
  path: string
  digest: string
}

interface DshSkillRegistry {
  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => {
    name: string
    list(options: { signal?: AbortSignal }): Promise<unknown>
    get(candidate: unknown, options: { signal?: AbortSignal }): Promise<unknown>
  }): () => void
}

type SkillAwareContext = Context & { skills: DshSkillRegistry }

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Load and validate the immutable Refine skill shipped in the package. */
export async function loadBundledRefineSkill(): Promise<BundledRefineSkill> {
  const text = await readFile(BUNDLED_SKILL_URL, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text)
  if (match === null) throw new Error('packaged refine skill has invalid frontmatter')
  const metadata = load(match[1]!)
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('packaged refine skill has invalid metadata')
  }
  const fields = metadata as Record<string, unknown>
  if (fields.name !== 'refine' || typeof fields.description !== 'string' || fields.description.length === 0) {
    throw new Error('packaged refine skill identity is invalid')
  }
  return {
    name: fields.name,
    description: fields.description,
    content: match[2]!.trimStart(),
    path: fileURLToPath(BUNDLED_SKILL_URL),
    digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  }
}

/**
 * Publish the packaged skill through DSH's native catalog and expose the same
 * structured Gear protocol used by the socket client.
 */
export async function mountDshRefineSkill(
  ctx: Context,
  gateway: RefineSkillGateway,
  identity: SkillHarnessIdentity,
): Promise<void> {
  const skill = await loadBundledRefineSkill()
  if (identity.runtime.type !== 'dsh' || identity.preset.id !== skill.name || identity.preset.digest !== skill.digest) {
    throw new Error('DSH skill mode must use the packaged refine skill identity')
  }

  const candidate = {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: BUNDLED_SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: BUNDLED_SKILL_ROOT },
    rank: 0,
    locator: skill.name,
    path: skill.path,
  } as const
  const definition = {
    name: skill.name,
    description: skill.description,
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    resourceBase: candidate.resourceBase,
    content: skill.content,
    path: skill.path,
  } as const
  ;(ctx as SkillAwareContext).skills.registerProvider(() => ({
    name: BUNDLED_SKILL_PROVIDER,
    async list() { return [candidate] },
    async get() { return definition },
  }))

  ctx.tools.register(defineTool({
    name: 'refine_request',
    description: 'Call the Gear Refine protocol from the packaged refine skill. DSH session identity is bound automatically.',
    parameters: {
      method: { type: 'string', required: true, description: 'Exact Gear Refine protocol method.' },
      params: { type: 'json', required: true, description: 'Method parameters. Omit clientId and identity; this tool binds them.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('refine_request requires an agent session')
      const request = exec.agent.session.requestHeader()?.config
      if (request === undefined
        || request.provider !== identity.model.provider
        || request.model !== identity.model.model
        || request.maxTokens !== identity.model.maxTokens
        || request.temperature !== identity.sampling?.temperature) {
        throw new Error('current DSH request identity does not match the immutable Gear configuration')
      }
      const params = typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params)
        ? { ...args.params as Record<string, unknown> }
        : (() => { throw new TypeError('params must be an object') })()
      const bytes = Buffer.byteLength(JSON.stringify({ method: args.method, params }), 'utf8')
      if (bytes > gateway.maxRequestBytes) throw new Error('refine request exceeds maxRequestBytes')
      const clientId = `dsh:${String(exec.agent.id)}`
      if (args.method === 'meta.claim') params.identity = identity
      if (args.method === 'meta.claim' || args.method === 'meta.call' || args.method.startsWith('candidate.')) {
        params.clientId = clientId
      }
      return jsonValue(await gateway.call(args.method, params))
    },
  }))
}
