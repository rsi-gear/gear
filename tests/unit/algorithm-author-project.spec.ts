import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { initAuthorProject } from '../../src/algorithm/author/project.js';
import { parseAuthorRunSpec } from '../../src/algorithm/author/run-resolver.js';

const roots: string[] = [];
function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'gear-author-project-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('publishes exactly five usable Python search files with a bounded exact SDK dependency', () => {
  const root = fixture(); const project = join(root, 'python-demo');
  const created = initAuthorProject({ directory: project, language: 'python', template: 'search', profile: 'lab' });
  expect(created.files).toEqual(['algorithm.py', 'run.yaml', 'roles.yaml', 'prompts/optimizer.md', 'requirements.txt']);
  expect(readdirSync(project).sort()).toEqual(['algorithm.py', 'prompts', 'requirements.txt', 'roles.yaml', 'run.yaml']);
  expect(readdirSync(join(project, 'prompts'))).toEqual(['optimizer.md']);
  const spec = parseAuthorRunSpec(loadYaml(readFileSync(join(project, 'run.yaml'), 'utf8'), { schema: JSON_SCHEMA }));
  expect(spec.profile).toBe('lab');
  expect(spec.algorithm).toEqual({ language: 'python', module: './algorithm.py', export: 'search' });
  expect(readFileSync(join(project, 'algorithm.py'), 'utf8')).toContain('@algorithm(config_schema=SEARCH_CONFIG_SCHEMA)');
  expect(readFileSync(join(project, 'requirements.txt'), 'utf8')).toMatch(/^gear-algorithm==0\.1\.0a0\n$/u);
  expect(() => initAuthorProject({ directory: project, language: 'python', template: 'search', profile: 'lab' }))
    .toThrow('not empty');
});

it('initializes an existing empty directory and freezes a supplied local Python wheel', () => {
  const root = fixture(); const project = join(root, 'empty'); mkdirSync(project);
  const wheel = join(root, 'gear_algorithm-0.1.0a0-py3-none-any.whl'); writeFileSync(wheel, 'local test wheel');
  const created = initAuthorProject({ directory: project, language: 'python', template: 'search',
    profile: 'lab', pythonSdkWheel: wheel });
  expect(created.source).toBe('local-artifact');
  expect(readFileSync(join(project, 'requirements.txt'), 'utf8')).toMatch(/^gear-algorithm @ file:\/\/\/.*#sha256=[a-f0-9]{64}\n$/u);
});

it('publishes the TypeScript author example with an exact host version and refuses linked targets', () => {
  const root = fixture(); const project = join(root, 'typescript-demo');
  initAuthorProject({ directory: project, language: 'typescript', template: 'search', profile: 'lab' });
  expect(readdirSync(project).sort()).toEqual(['algorithm.ts', 'package.json', 'prompts', 'roles.yaml', 'run.yaml']);
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  expect(pkg.dependencies['rsi-gear']).toBe('0.1.1');
  expect(readFileSync(join(project, 'algorithm.ts'), 'utf8')).toContain('configSchema: searchConfigSchema');
  const link = join(root, 'link'); symlinkSync(project, link);
  expect(() => initAuthorProject({ directory: link, language: 'python', template: 'search', profile: 'lab' }))
    .toThrow('real directory');
  const dangling = join(root, 'dangling'); symlinkSync(join(root, 'missing'), dangling);
  expect(() => initAuthorProject({ directory: dangling, language: 'python', template: 'search', profile: 'lab' }))
    .toThrow('real directory');
});
