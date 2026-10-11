/** Administrator-owned generic physical host; no algorithm-specific branches. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createHitchExecutionHost, createDshModelServices, createRestrictedAlgorithmDshHost,
  HarnessBuilder, SubprocessHarnessCompiler, CandidateWorkspaceManager, HitchCliEvaluator } from 'rsi-gear/algorithm/harness';
import { registerModel } from './model.mjs';

export const hostProfile = { async create(context) {
  const settingsPath = join(context.configDir, 'host.settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const fingerprint = () => {
    const hash = createHash('sha256');
    for (const path of [settingsPath, join(context.configDir, 'model.mjs'), ...(settings.runtimeResources ?? [])]) {
      hash.update(path); hash.update('\0'); hash.update(readFileSync(resolve(context.configDir, path)));
    }
    return hash.digest('hex');
  };
  const runtimeDigest = fingerprint();
  const builder = new HarnessBuilder({ ...settings.builder, compiler: new SubprocessHarnessCompiler(settings.compiler) });
  const evaluator = new HitchCliEvaluator(settings.hitch);
  const workspaceManager = new CandidateWorkspaceManager({ ...settings.workspace,
    rootForEvolution: id => join(context.stateDir, 'workspaces', id) });
  await builder.initialize(); await workspaceManager.initialize();
  const dsh = await createRestrictedAlgorithmDshHost(registerModel);
  try {
    await dsh.context.llm.resolveModelInfo(settings.metaAgent.model.provider, settings.metaAgent.model.model);
    const role = (id, definition) => ({ id, spec: settings.metaAgent, ...definition });
    return await createHitchExecutionHost(context, { ...settings.execution, builder, evaluator,
      operationLimits: settings.operationLimits,
      modelServices: (ctx, capabilities) => createDshModelServices(ctx, capabilities, {
        dshContext: dsh.context, builder, workspaceManager,
        editors: Object.entries(settings.editors).map(([id, definition]) => role(id, definition)),
        analysts: Object.entries(settings.analysts ?? {}).map(([id, definition]) => role(id, definition)),
        runtimeDigest, currentRuntimeDigest: fingerprint,
        authorize(roleId, envelope) {
          if (envelope.campaignId !== context.campaignId
            || !(roleId in settings.editors || roleId in (settings.analysts ?? {}))) throw Error('Model role is not authorized');
        }, close: () => dsh.close(),
      }),
    });
  } catch (error) { await dsh.close(); throw error; }
} };
