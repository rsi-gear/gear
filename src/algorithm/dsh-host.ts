import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';

export { LlmAdapter, CallId } from '@deepseek-ai/dsh-llm';
export type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

export type RestrictedDshHost = { context: Context; close(): Promise<void> };

/**
 * A restricted DSH runtime for algorithm roles. The host owns its model adapter
 * and destination policy; recipe code never receives that credential or Context.
 * An interrupted model turn remains an unknown operation until reconciled.
 */
export async function createRestrictedAlgorithmDshHost(registerModel: (llm: LlmRuntime) => void | Promise<void>):
Promise<RestrictedDshHost> {
  const context = new Context();
  try {
    new AgentRegistry(context);
    new SessionStore(context);
    new SystemPrompt(context, { includeHarnessIdentity: false, includeRuntimeContext: false });
    new ToolRuntime(context);
    new LlmRuntime(context);
    await context.plugin(AgentLoop, { agents: [] });
    // Operation journals carry the recovery truth. This does not claim to
    // persist arbitrary DSH sessions after a process crash.
    context.on('session/flush', async () => {});
    context.provide('agentPresets', { mount: async () => {} } as never);
    await registerModel(context.llm);
    return { context, close: () => context.fiber.dispose() };
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
