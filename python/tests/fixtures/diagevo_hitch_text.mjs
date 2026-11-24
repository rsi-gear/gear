// Contract probe: use the actual separately built Hitch proxy and model-call.
// The Python caller owns a native Gear gateway with an explicit model double.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hitch = process.env.GEAR_DIAGEVO_HITCH_PATH;
if (!hitch) throw new Error('GEAR_DIAGEVO_HITCH_PATH must identify the tested Hitch checkout');
const { HostModelProxy, parseTrainingBinding, trainingProxyIdentity } = await import(pathToFileURL(path.join(hitch, 'dist/src/model-access/index.js')).href);
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw), binding = parseTrainingBinding(input.binding);
const proxy = await HostModelProxy.start({ captureRoot: input.captureRoot, evalId: `eval_${'b'.repeat(32)}`, mode: 'proxy', required: true,
  trainingEndpoint: { schema_version: '1', binding, base_url: input.endpoint, credential: input.credential },
  upstreams: { openai: input.endpoint }, upstreamAuthorizations: { openai: `Bearer ${input.credential}` },
  upstreamWireModels: { openai: binding.expectedPolicyVersion }, credentialValues: [input.credential],
  bindHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
let child;
try {
  child = spawn(process.execPath, [path.join(hitch, 'integrations/model-call/cli.js'), '--model', `training/${binding.bindingId}`], {
    env: { PATH: process.env.PATH, HITCH_HARBOR_INTERNAL: '1', HITCH_TRAINING_EXTERNAL: '1', HITCH_TRAINING_RUN_ID: input.runId,
      HITCH_TRAINING_BINDING: JSON.stringify(trainingProxyIdentity(binding)), OPENAI_API_KEY: 'hitch-training-external',
      OPENAI_BASE_URL: `${proxy.localBaseUrl}/${input.runId}/openai` }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const closed = once(child, 'close'); child.stdin.end(JSON.stringify(input.prompt));
  const [code] = await closed; process.exitCode = code ?? 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await proxy.close();
}
