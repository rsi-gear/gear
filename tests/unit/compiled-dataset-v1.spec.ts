import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectStandardCompiledDatasetV1 } from '../../src/search/compiled-dataset-v1.js';
import { digestDatasetRef } from '../../src/state/dataset.js';
import { digestJson } from '../../src/state/digest.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

it('admits the Hitch v1 file-record digest while retaining Gear task content identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-standard-task-')); roots.push(root);
  const dataset = await standardSearchDataset(root, 1), task = join(dataset.ref, 'task-0');
  await mkdir(join(task, 'empty')); await mkdir(join(task, 'environment'));
  await writeFile(join(task, 'environment/start.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(task, 'environment/start.sh'), 0o755);
  // Independent protocol vector: depth-first locale ordering, files only, raw file SHA-256 and mode names.
  const rows = [
    { path: 'environment/start.sh', mode: 'executable', sha256: sha('#!/bin/sh\nexit 0\n') },
    { path: 'instruction.md', mode: 'file', sha256: sha('seed fixture task 0\n') },
    { path: 'task.toml', mode: 'file', sha256: sha('version = "1.0"\n[verifier]\ntimeout_sec = 60\n') },
  ];
  const externalDigest = `sha256:${sha(JSON.stringify(rows))}`;
  const manifestPath = join(dataset.ref, 'benchmark.adapter.json');
  const { dataset_digest: _oldDigest, ...body } = JSON.parse(await readFile(manifestPath, 'utf8'));
  body.tasks[0].task_digest = externalDigest;
  await writeFile(manifestPath, JSON.stringify({ ...body, dataset_digest: digestJson(body) }));
  const inspected = await inspectStandardCompiledDatasetV1(dataset.ref);
  expect(inspected.tasks).toEqual([{ id: 'task-0', contentDigest: await digestDatasetRef(task) }]);
  expect(inspected.tasks[0]!.contentDigest).not.toBe(externalDigest);
  expect(inspected.sourceDigest).toBe(await digestDatasetRef(dataset.ref));
  await chmod(join(task, 'environment/start.sh'), 0o644);
  await expect(inspectStandardCompiledDatasetV1(dataset.ref)).rejects.toThrow('bytes differ from manifest');
  await chmod(join(task, 'environment/start.sh'), 0o755);
  await writeFile(join(task, 'instruction.md'), 'changed task\n');
  await expect(inspectStandardCompiledDatasetV1(dataset.ref)).rejects.toThrow('bytes differ from manifest');
});

it('rejects a Gear internal tree digest used as an external Hitch task_digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-task-digest-boundary-')); roots.push(root);
  const dataset = await standardSearchDataset(root, 1);
  const manifestPath = join(dataset.ref, 'benchmark.adapter.json');
  const { dataset_digest: _oldDigest, ...body } = JSON.parse(await readFile(manifestPath, 'utf8'));
  body.tasks[0].task_digest = await digestDatasetRef(join(dataset.ref, 'task-0'));
  await writeFile(manifestPath, JSON.stringify({ ...body, dataset_digest: digestJson(body) }));
  await expect(inspectStandardCompiledDatasetV1(dataset.ref)).rejects.toThrow('bytes differ from manifest');
});
