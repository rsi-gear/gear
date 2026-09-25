import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPythonAuthorReplayPort, type SealedPythonReplayPort } from '../../src/algorithm/author/python-port.js';
import { AUTHOR_WIRE_VERSION_V2 } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
const ports: SealedPythonReplayPort[] = [];
afterEach(async () => {
  await Promise.all(ports.splice(0).map(port => port.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const interpreter = [process.env.GEAR_ALGORITHM_TEST_PYTHON, '/opt/homebrew/bin/python3.11', 'python3.11']
  .find(candidate => {
    if (!candidate) return false;
    try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
      { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
  });

(interpreter ? it : it.skip)('freezes v2 Python definition metadata during admission without a replay wave', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-py-description-')); roots.push(root);
  writeFileSync(join(root, 'algorithm.py'), `from gear_algorithm.author import algorithm
@algorithm(config_schema={"type":"object","required":["mode"],"properties":{"mode":{"type":"string","enum":[str(hash("sealed-definition"))]}},"additionalProperties":False})
async def sample(ctx):
    return ctx.result(selected=ctx.initial_agent)
`);
  const prior = process.env.PYTHONHASHSEED;
  const make = async (mark: string) => {
    process.env.PYTHONHASHSEED = mark;
    const port = await createPythonAuthorReplayPort({ configDir: root, module: 'algorithm.py', export: 'sample',
      interpreter: interpreter!, sdkPath: resolve('packages/python-sdk/src'), wireVersion: AUTHOR_WIRE_VERSION_V2 });
    ports.push(port);
    return port;
  };
  try {
    const first = await make('1');
    expect(first.definitionDescription?.apiVersion).toBe('gear.author.replay.v1');
    expect(first.definitionDescription?.configSchema).toMatchObject({ properties: { mode: { enum: [expect.any(String)] } } });
    const second = await make('2');
    expect(second.definitionDescription?.configSchema).not.toEqual(first.definitionDescription?.configSchema);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    expect(second.hostDigest).toBe(first.hostDigest);
    expect(Object.isFrozen(first.definitionDescription?.configSchema)).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.PYTHONHASHSEED;
    else process.env.PYTHONHASHSEED = prior;
  }
});
