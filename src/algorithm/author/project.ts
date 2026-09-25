/** The five editable files in a v2 author project. Runtime and administrator files live elsewhere. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync,
  realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readBoundedFile } from './identity.js';

export type AuthorProjectLanguage = 'python' | 'typescript';
export type InitAuthorProjectOptions = { directory: string; language: AuthorProjectLanguage;
  template: 'search'; profile: string; sdkPackage?: string; pythonSdkWheel?: string };
export type InitializedAuthorProject = { directory: string; files: string[]; dependency: string;
  source: 'local-artifact' | 'exact-version' };

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const pythonVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:a[0-9]+|b[0-9]+|rc[0-9]+|\.post[0-9]+|\.dev[0-9]+)?$/u;
const profilePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function hostPackage(): { name: string; version: string } {
  const path = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const value: unknown = JSON.parse(readBoundedFile(path, 1024 * 1024).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Host package metadata invalid');
  const { name, version } = value as Record<string, unknown>;
  if (name !== 'rsi-gear' || typeof version !== 'string' || !versionPattern.test(version))
    throw new Error('Host author SDK name/version invalid');
  return { name, version };
}
function pythonSdkVersion(): string {
  const path = fileURLToPath(new URL('../../../packages/python-sdk/pyproject.toml', import.meta.url));
  const source = readBoundedFile(path, 1024 * 1024).toString('utf8');
  const marker = /^\[project\][ \t]*$/mu.exec(source);
  if (!marker) throw new Error('Bundled Python author SDK project metadata missing');
  const remainder = source.slice(marker.index + marker[0].length);
  const nextSection = /^\[/mu.exec(remainder)?.index ?? remainder.length;
  const section = remainder.slice(0, nextSection);
  const name = /^name\s*=\s*"([^"]+)"[ \t]*$/mu.exec(section)?.[1];
  const version = /^version\s*=\s*"([^"]+)"[ \t]*$/mu.exec(section)?.[1];
  if (name !== 'gear-algorithm' || !version || !pythonVersionPattern.test(version))
    throw new Error('Bundled Python author SDK name/version invalid');
  return version;
}
function localPackage(path: string, suffix: string): string {
  const named = resolve(path);
  if (extname(named) !== suffix || lstatSync(named).isSymbolicLink() || !lstatSync(named).isFile())
    throw new Error(`Local author SDK must be a regular ${suffix} file`);
  return realpathSync(named);
}
function pythonDependency(wheel?: string): { value: string; source: InitializedAuthorProject['source'] } {
  const version = pythonSdkVersion();
  if (!wheel) return { value: `gear-algorithm==${version}`, source: 'exact-version' };
  const path = localPackage(wheel, '.whl');
  if (!new RegExp(`^gear_algorithm-${version.replaceAll('.', '\\.')}-[^-]+-[^-]+-[^-]+\\.whl$`, 'u').test(basename(path)))
    throw new Error(`Python author wheel filename must match bundled SDK version ${version}`);
  const sha256 = createHash('sha256').update(readBoundedFile(path, 128 * 1024 * 1024)).digest('hex');
  return { value: `gear-algorithm @ ${pathToFileURL(path).href}#sha256=${sha256}`, source: 'local-artifact' };
}
function typescriptDependency(tarball?: string): { value: string; source: InitializedAuthorProject['source'] } {
  const { version } = hostPackage();
  if (!tarball) return { value: version, source: 'exact-version' };
  const path = localPackage(tarball, '.tgz');
  // npm install records sha512 integrity in package-lock.json; installed admission verifies that exact tarball.
  readBoundedFile(path, 128 * 1024 * 1024);
  return { value: `file:${path}`, source: 'local-artifact' };
}
function runYaml(language: AuthorProjectLanguage, profile: string): string {
  const module = language === 'python' ? './algorithm.py' : './algorithm.ts';
  return `schemaVersion: 2\nalgorithm: {language: ${language}, module: ${module}, export: search}\nprofile: ${profile}\nroles: ./roles.yaml\ninputs:\n  initialAgent: {profileAlias: initialAgent}\n  searchTasks: {profileAlias: searchTasks}\nconfig:\n  rounds: 3\n  taskCount: 10\n  proposalCount: 4\n  seed: 42\n`;
}
const rolesYaml = `schemaVersion: 1\nroles:\n  optimizer:\n    template: harness-editor\n    prompt: ./prompts/optimizer.md\n    inputSchema: sdk:harness-edit-input.v1\n    resultSchema: sdk:harness-edit-result.v1\n`;
const optimizerPrompt = `根据提供的任务反馈改进当前 Harness。\n先定位失败原因，再在允许的文件范围内完成一次有明确假设的修改。\n保留原有任务接口。按模板要求返回修改摘要和依据。\n`;
const pythonAlgorithm = `from gear_algorithm.author import SEARCH_CONFIG_SCHEMA, algorithm\n\n\n@algorithm(config_schema=SEARCH_CONFIG_SCHEMA)\nasync def search(ctx):\n    best = ctx.initial_agent\n    tasks = await ctx.tasks.sample(\n        ctx.data.search_tasks, count=ctx.config.taskCount, seed=ctx.config.seed,\n    )\n    archive = []\n    for round_index in range(ctx.config.rounds):\n        baseline = await ctx.evaluate(best, tasks=tasks)\n        if not baseline.comparable:\n            await ctx.checkpoint("baseline-incomplete", baseline)\n            return ctx.result(outputs={"incomplete": baseline})\n\n        proposed = await ctx.propose(\n            best, feedback=baseline, role="optimizer", count=ctx.config.proposalCount,\n        )\n        settled = await ctx.parallel([\n            ctx.evaluate(candidate, tasks=tasks) for candidate in proposed.candidates\n        ])\n        measured = [item.value for item in settled if item.ok]\n        best = ctx.select(\n            [baseline, *measured], metric="pass_rate", require_improvement=True,\n        ).agent\n        archive.append({\n            "round": round_index, "baseline": baseline, "proposals": proposed,\n            "evaluations": settled, "selected": best,\n        })\n        await ctx.checkpoint("population", archive)\n\n    return ctx.result(selected=best, outputs={"population": archive})\n`;
const typescriptAlgorithm = `import { algorithm, searchConfigSchema,\n  type SearchConfig, type SearchRoundRecord } from 'rsi-gear/algorithm/author';\n\nexport const search = algorithm<SearchConfig>(async ctx => {\n  let best = ctx.initialAgent;\n  const tasks = await ctx.tasks.sample(ctx.data.searchTasks,\n    { count: ctx.config.taskCount, seed: ctx.config.seed });\n  const archive: SearchRoundRecord[] = [];\n  for (let round = 0; round < ctx.config.rounds; round++) {\n    const baseline = await ctx.evaluate(best, { tasks });\n    if (!baseline.comparable) {\n      await ctx.checkpoint('baseline-incomplete', baseline);\n      return ctx.result({ outputs: { incomplete: baseline } });\n    }\n    const proposed = await ctx.propose(best, { feedback: baseline, role: 'optimizer',\n      count: ctx.config.proposalCount });\n    const evaluations = await ctx.parallel(\n      proposed.candidates.map(candidate => ctx.evaluate(candidate, { tasks })));\n    const measured = evaluations.flatMap(item => item.ok ? [item.value] : []);\n    best = ctx.select([baseline, ...measured],\n      { metric: 'pass_rate', requireImprovement: true }).agent;\n    archive.push({ round, baseline, proposals: proposed, evaluations, selected: best });\n    await ctx.checkpoint('population', archive);\n  }\n  return ctx.result({ selected: best, outputs: { population: archive } });\n}, { configSchema: searchConfigSchema });\n`;

function targetState(path: string): 'absent' | 'empty' {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Author project target must be a real directory');
  if (readdirSync(path).length !== 0) throw new Error('Author project target is not empty; refusing to overwrite');
  return 'empty';
}
function stageFile(root: string, name: string, content: string): void {
  const path = join(root, name);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
}

/** Stages every editable file, then publishes the complete project in one directory rename. */
export function initAuthorProject(options: InitAuthorProjectOptions): InitializedAuthorProject {
  if (options.language !== 'python' && options.language !== 'typescript') throw new Error('Author language must be python or typescript');
  if (options.template !== 'search') throw new Error('Only the search author template is supported');
  if (!profilePattern.test(options.profile)) throw new Error('Author profile alias invalid');
  if (options.language === 'python' && options.sdkPackage || options.language === 'typescript' && options.pythonSdkWheel)
    throw new Error('SDK artifact option does not match author language');
  const target = resolve(options.directory);
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
    throw new Error('Author project parent must be an existing real directory');
  const state = targetState(target);
  const dependency = options.language === 'python'
    ? pythonDependency(options.pythonSdkWheel) : typescriptDependency(options.sdkPackage);
  const files = options.language === 'python'
    ? ['algorithm.py', 'run.yaml', 'roles.yaml', 'prompts/optimizer.md', 'requirements.txt']
    : ['algorithm.ts', 'run.yaml', 'roles.yaml', 'prompts/optimizer.md', 'package.json'];
  const stage = join(parent, `.${basename(target)}.staging-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  let published = false;
  let removedEmptyTarget = false;
  try {
    mkdirSync(join(stage, 'prompts'), { mode: 0o700 });
    stageFile(stage, 'run.yaml', runYaml(options.language, options.profile));
    stageFile(stage, 'roles.yaml', rolesYaml);
    stageFile(stage, 'prompts/optimizer.md', optimizerPrompt);
    if (options.language === 'python') {
      stageFile(stage, 'algorithm.py', pythonAlgorithm);
      stageFile(stage, 'requirements.txt', `${dependency.value}\n`);
    } else {
      stageFile(stage, 'algorithm.ts', typescriptAlgorithm);
      stageFile(stage, 'package.json', `${JSON.stringify({ private: true, type: 'module',
        dependencies: { 'rsi-gear': dependency.value } }, null, 2)}\n`);
    }
    if (state === 'empty') {
      if (targetState(target) !== 'empty') throw new Error('Author project target changed during init');
      rmdirSync(target);
      removedEmptyTarget = true;
    } else if (targetState(target) !== 'absent') throw new Error('Author project target appeared during init');
    renameSync(stage, target);
    published = true;
    return { directory: target, files, dependency: dependency.value, source: dependency.source };
  } finally {
    if (!published) {
      rmSync(stage, { recursive: true, force: true });
      if (removedEmptyTarget && !existsSync(target)) mkdirSync(target, { mode: 0o700 });
    }
  }
}
