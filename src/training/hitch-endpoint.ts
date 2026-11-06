import { join } from 'node:path'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { atomicWrite } from './store.js'
import type { ReadyEvaluationEndpointBinding } from './types.js'

/** Hitch's real text, SSE and complete function-tool roundtrip probes. */
export async function verifyHitchEndpoint(binding: ReadyEvaluationEndpointBinding,
  options: { command: string[]; root: string; workspace: string }, timeoutMs: number): Promise<void> {
  requireContract(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
    'invalid-endpoint-probe-timeout', 'endpoint capability verification needs a finite positive timeout')
  const deadline = Date.now() + timeoutMs
  const name = binding.endpoint_ref.match(/^endpoint\/([a-z0-9][a-z0-9._-]{0,63})(?:@sha256:[a-f0-9]{64})?$/)?.[1]
  requireContract(name, 'invalid-endpoint-ref', 'managed endpoint must have a bounded Hitch endpoint name')
  const config = { schema_version: '1', base_url: binding.connection.base_url, wire_model: binding.wire_model,
    api: binding.api, auth: binding.connection.auth, capabilities: binding.capabilities }
  requireContract(digestJson(config) === binding.endpoint_revision, 'endpoint-revision-drift', 'endpoint connection differs from the frozen revision')
  const file = join(options.workspace, 'endpoint-probes', `${binding.endpoint_revision.slice(7)}.json`)
  await atomicWrite(file, config)
  const call = async (args: string[]) => {
    const remaining = deadline - Date.now()
    requireContract(remaining > 0, 'endpoint-probe-timeout', 'endpoint capability verification exhausted its startup deadline')
    return await jsonProcess(options.command, ['--root', options.root, ...args], undefined, remaining) as Record<string, unknown>
  }
  const registered = await call(['models', 'connect', '--name', name, '--file', file, '--persist-credential', '--json'])
  requireContract(registered.endpoint_revision === binding.endpoint_revision && registered.wire_model === binding.wire_model
    && registered.api === binding.api, 'endpoint-probe-drift', 'Hitch registered another endpoint identity')
  const inspected = await call(['models', 'inspect', `endpoint/${name}@${binding.endpoint_revision}`, '--verify', '--json'])
  const verification = inspected.verification as Record<string, unknown> | undefined
  requireContract(inspected.endpoint_revision === binding.endpoint_revision && inspected.wire_model === binding.wire_model && verification?.api === binding.api
    && verification.endpoint_revision === binding.endpoint_revision && (!binding.capabilities.streaming || verification.streaming === true)
    && (!binding.capabilities.tool_calls || verification.tool_calls === true)
    && (!binding.capabilities.streaming || !binding.capabilities.tool_calls || verification.streamed_tool_calls === true),
  'endpoint-capabilities-unverified', 'Hitch did not verify the required text, streaming and tool roundtrip capabilities')
}
