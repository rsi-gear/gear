import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'gear-algorithm-consumer-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const buildPython = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
function run(command, args, cwd, env = {}) {
  try {
    return execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024, timeout: 180_000 })
  } catch (error) {
    process.stderr.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? '')
    throw error
  }
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function withPython(configPath, python) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  function replace(value) {
    if (Array.isArray(value)) value.forEach(replace)
    else if (value && typeof value === 'object') {
      if (value.language === 'python') value.interpreter = python
      Object.values(value).forEach(replace)
    }
  }
  replace(config)
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
function algorithm(cli, action, config, cwd, env = {}) {
  const output = run(process.execPath, [cli, 'algorithm', action, config], cwd, env)
  return JSON.parse(output.trim().split('\n').at(-1))
}

try {
  const packageFile = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--offline', '--json',
    '--pack-destination', temporary], root))[0]
  const tarball = join(temporary, packageFile.filename)
  const consumer = join(temporary, 'consumer')
  await cp(join(root, 'examples/algorithms/python-toy'), join(consumer, 'python-toy'), { recursive: true })
  await cp(join(root, 'examples/algorithms/cross-language-hook'), join(consumer, 'cross-language-hook'), { recursive: true })
  await cp(join(root, 'examples/algorithms/ts-toy'), join(consumer, 'ts-toy'), { recursive: true })
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'gear-algorithm-external-consumer',
    version: '1.0.0', private: true, type: 'module' }))
  run(npm, ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], consumer)
  const cli = join(consumer, 'node_modules/rsi-gear/lib/cli.js')
  const installed = join(consumer, 'node_modules/rsi-gear')
  const installedAuthorGuide = await readFile(join(installed, 'docs/algorithm-authoring.zh-CN.md'), 'utf8')
  const installedPythonGuide = await readFile(join(installed, 'packages/python-sdk/README.md'), 'utf8')
  const installedBaselineGuide = await readFile(join(installed, 'docs/algorithm-baselines/f715748/README.md'), 'utf8')
  const installedBaselineManifest = JSON.parse(await readFile(join(installed,
    'docs/algorithm-baselines/f715748/manifest.json'), 'utf8'))
  assert.match(installedAuthorGuide, /gear-algorithm/)
  assert.match(installedPythonGuide, /gear-algorithm/)
  assert.match(installedBaselineGuide, /f715748/)
  assert.equal(installedBaselineManifest.revision, 'f715748dad576d3055e4a9eaab21b36015348aee')
  const publicExports = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
    const core = await import('rsi-gear/algorithm')
    const recipes = await import('rsi-gear/algorithm/recipes')
    const legacy = await import('rsi-gear/algorithm/legacy')
    const author = await import('rsi-gear/algorithm/author')
    console.log(JSON.stringify({ workflow: typeof core.defineWorkflow,
      rho: recipes.rhoRecipe.module, ahe: recipes.aheRecipe.language,
      evo: recipes.evoRecipe.language, legacy: typeof legacy.verifyPinnedLegacySearchClosure,
      authorAlgorithm: typeof author.algorithm, authorWorkflow: typeof author.workflow,
      authorReplay: typeof author.replay }))
  `], consumer))
  assert.deepEqual(publicExports, { workflow: 'function', rho: 'gear_algorithm.recipes.rho',
    ahe: 'python', evo: 'python', legacy: 'function', authorAlgorithm: 'function',
    authorWorkflow: 'function', authorReplay: 'function' })
  const heavyConsumer = join(temporary, 'heavy-consumer')
  await (await import('node:fs/promises')).mkdir(heavyConsumer)
  await writeFile(join(heavyConsumer, 'package.json'), JSON.stringify({ name: 'gear-algorithm-heavy-consumer',
    version: '1.0.0', private: true, type: 'module' }))
  // DSH modules use peer-to-peer imports within the complete installed DSH
  // family; install that exact family explicitly in this separate consumer.
  const hostPackages = (await readdir(join(root, 'node_modules/@deepseek-ai')))
    .map(name => `@deepseek-ai/${name}`)
  const installedPeers = await Promise.all(hostPackages.map(async name => {
    const packageJson = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    return `${name}@${packageJson.version}`
  }))
  run(npm, ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund',
    tarball, ...installedPeers], heavyConsumer)
  const heavyExports = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
    const gepa = await import('rsi-gear/algorithm/gepa')
    const harness = await import('rsi-gear/algorithm/harness')
    const training = await import('rsi-gear/algorithm/training')
    console.log(JSON.stringify({ create: typeof gepa.createGepaRound,
      next: typeof gepa.nextGepaRound, evaluate: typeof gepa.GepaEvaluationProvider,
      physicalGepa: typeof gepa.createPhysicalGepaHooks,
      fresh: typeof harness.createFreshRecipeHostProfile,
      configured: typeof harness.createConfiguredFreshHostProfile,
      dsh: typeof harness.createRestrictedAlgorithmDshHost,
      builder: typeof harness.HarnessBuilder,
      compiler: typeof harness.SubprocessHarnessCompiler,
      workspace: typeof harness.CandidateWorkspaceManager,
      hitch: typeof harness.HitchCliEvaluator,
      train: typeof training.fixedHarnessGrpoRecipe }))
  `], heavyConsumer))
  assert.deepEqual(heavyExports, { create: 'function', next: 'function', evaluate: 'function',
    physicalGepa: 'function', fresh: 'function', configured: 'function', dsh: 'function',
    builder: 'function', compiler: 'function', workspace: 'function', hitch: 'function',
    train: 'function' })

  const wheelDir = join(temporary, 'wheels')
  const sdkCopy = join(temporary, 'python-sdk')
  await cp(join(root, 'packages/python-sdk'), sdkCopy, { recursive: true })
  run(buildPython, ['-m', 'pip', 'wheel', '--no-build-isolation', '--no-deps', '--wheel-dir', wheelDir,
    sdkCopy], root)
  const wheel = (await import('node:fs/promises')).readdir(wheelDir).then(names => names.find(name => name.endsWith('.whl')))
  const wheelPath = join(wheelDir, (await wheel) ?? 'missing-wheel')
  const venv = join(temporary, 'clean-python')
  run(buildPython, ['-m', 'venv', venv], root)
  const python = process.platform === 'win32' ? join(venv, 'Scripts/python.exe') : join(venv, 'bin/python')
  run(python, ['-m', 'pip', 'install', '--no-index', '--no-deps', wheelPath], root)
  run(python, ['-c', "import gear_algorithm, importlib.util; from gear_algorithm.author import algorithm, workflow, replay; assert callable(algorithm) and callable(workflow) and callable(replay); assert importlib.util.find_spec('torch') is None; assert importlib.util.find_spec('optuna') is None"], root)
  await cp(join(root, 'examples/algorithms/host-setup/recorded-check.mjs'),
    join(heavyConsumer, 'recorded-check.mjs'))
  const physicalAdmission = JSON.parse(run(process.execPath, ['recorded-check.mjs'], heavyConsumer, {
    GEAR_ALGORITHM_PACKAGE_PYTHON: python,
    GEAR_ALGORITHM_PACKAGE_CLI: join(heavyConsumer, 'node_modules/rsi-gear/lib/cli.js'),
  }))
  assert.equal(physicalAdmission.configuredPhysicalHost, true)
  assert.equal(physicalAdmission.publicCliCheck, true)

  for (const name of ['python-toy', 'cross-language-hook', 'ts-toy']) {
    const project = join(consumer, name)
    const config = join(project, 'gear.algorithm.json')
    await withPython(config, python)
    assert.equal(algorithm(cli, 'check', config, project).ok, true)
    assert.equal(algorithm(cli, 'run', config, project).status, 'complete')
    assert.equal(algorithm(cli, 'resume', config, project).status, 'complete')
  }

  const baselinePath = join(root, '.evolve-lab/algorithm-baselines/f715748/rsi-gear-0.1.0.tgz')
  const baseline = JSON.parse(await readFile(join(root, 'docs/algorithm-baselines/f715748/manifest.json'), 'utf8'))
  assert.equal(`sha256:${sha256(await readFile(baselinePath))}`, baseline.packageTarball.sha256)
  const oldPackage = join(temporary, 'old-package')
  await (await import('node:fs/promises')).mkdir(oldPackage)
  run('tar', ['-xzf', baselinePath, '-C', oldPackage], root)
  const legacy = await import(pathToFileURL(join(consumer, 'node_modules/rsi-gear/lib/algorithm/legacy.js')).href)
  const checked = legacy.verifyPinnedLegacySearchClosure(join(oldPackage, 'package'),
    join(root, 'docs/algorithm-baselines/f715748/manifest.json'), baselinePath)
  assert.equal(checked.searchIntegrity, baseline.builtSearch.integrity)
  assert.equal(checked.parentPolicyIntegrity, baseline.builtParentPolicy.integrity)
  const oldIdentity = await import(pathToFileURL(join(oldPackage, 'package/lib/search/identity.js')).href)
  assert.equal(oldIdentity.searchImplementationIntegrity, baseline.builtSearch.integrity)
  const oldRoot = join(oldPackage, 'package')
  const oldLock = process.env.GEAR_ALGORITHM_BASELINE_LOCK_FILE
    ? await readFile(process.env.GEAR_ALGORITHM_BASELINE_LOCK_FILE, 'utf8')
    : run('git', ['-C', process.env.GEAR_ALGORITHM_BASELINE_GIT_ROOT ?? root,
      'show', `${baseline.revision}:package-lock.json`], root)
  assert.equal(`sha256:${sha256(Buffer.from(oldLock))}`, baseline.packageLock.sha256)
  await writeFile(join(oldRoot, 'package-lock.json'), oldLock)
  assert.equal(process.version, baseline.environment.node)
  assert.equal(run(npm, ['--version'], root).trim(), baseline.environment.npm)
  run(npm, ['ci', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund'], oldRoot)
  // The example is a nested package, so resolve its self import back to the
  // exact extracted runtime rather than installing a second, unpinned copy.
  await symlink(oldRoot, join(oldRoot, 'node_modules/rsi-gear'), 'dir')
  const oldTypeScript = JSON.parse(await readFile(join(oldRoot, 'node_modules/typescript/package.json'), 'utf8'))
  assert.equal(oldTypeScript.version, baseline.environment.typescript)
  const oldConsumer = join(oldRoot, 'examples/parent-policy')
  const oldRun = JSON.parse(run(process.execPath, ['demo.mjs'], oldConsumer))
  assert.equal(oldRun.recovered, true)
  assert.equal(oldRun.replayedWithoutNewEvaluations, true)
  await writeFile(join(oldConsumer, 'persisted-recovery.mjs'), `import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { ComponentRegistry, SearchStore } from 'rsi-gear/search/api'
import { FailureClusterSearch } from 'rsi-gear/search/presets/failure-cluster-gepa'
import { createToySearch, createToySettings } from 'rsi-gear/search/testing'
import { implementation, ref, uniformParentPolicy } from './uniform-parent.mjs'
const phase = process.argv[2]
const components = new ComponentRegistry()
components.registerParentSelectionPolicy(ref.id, implementation, uniformParentPolicy)
const settings = createToySettings(); settings.search.parentPolicy = ref
const fixture = createToySearch()
const journal = new SearchStore('./old-state')
const admission = { evolutionId: 'toy', roundId: 'toy-round', roundIndex: 0, maxCandidates: 2,
  anchor: fixture.anchor, championRevisionDigest: fixture.anchor.digest, settings }
if (phase === 'interrupt') {
  const write = journal.write.bind(journal)
  let interrupted = false
  journal.write = async (name, value) => {
    await write(name, value)
    if (!interrupted && name === 'rounds/toy-round/parents') { interrupted = true; throw Error('injected interruption') }
  }
  await assert.rejects(new FailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks, components)
    .run(admission, new AbortController().signal), /injected interruption/)
  assert.equal(interrupted, true)
} else if (phase === 'resume') {
  const result = await new FailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks, components)
    .run(admission, new AbortController().signal)
  assert.ok(await journal.archive())
  await writeFile('old-result.json', JSON.stringify({ digest: result.digest }))
} else if (phase === 'replay') {
  const saved = JSON.parse(await readFile('old-result.json', 'utf8'))
  const result = await new FailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks, components)
    .run(admission, new AbortController().signal)
  assert.equal(result.digest, saved.digest)
  assert.equal(fixture.executions.length, 0)
} else throw Error('unknown recovery phase')
console.log(JSON.stringify({ phase, executions: fixture.executions.length }))
`)
  for (const phase of ['interrupt', 'resume', 'replay']) {
    const result = JSON.parse(run(process.execPath, ['persisted-recovery.mjs', phase], oldConsumer))
    assert.equal(result.phase, phase)
  }

  if (process.env.GEAR_ALGORITHM_OPTUNA_TEST_PYTHON) {
    const optunaPython = process.env.GEAR_ALGORITHM_OPTUNA_TEST_PYTHON
    run(optunaPython, ['-c', "import optuna; assert optuna.__version__.startswith('4.9.')"], root)
    const site = join(temporary, 'optuna-wheel-site')
    run(buildPython, ['-m', 'pip', 'install', '--no-index', '--no-deps', '--target', site, wheelPath], root)
    const optunaProject = join(consumer, 'optuna')
    await cp(join(root, 'examples/algorithms/optuna'), optunaProject, { recursive: true })
    const env = { PYTHONPATH: site }
    run(optunaPython, ['make_config.py'], optunaProject, env)
    const config = join(optunaProject, 'gear.algorithm.json')
    assert.equal(algorithm(cli, 'check', config, optunaProject, env).ok, true)
    assert.equal(algorithm(cli, 'run', config, optunaProject, env).status, 'complete')
    assert.equal(algorithm(cli, 'resume', config, optunaProject, env).status, 'complete')
  }
  process.stdout.write(JSON.stringify({ npmTarball: packageFile.filename, pythonWheel: (await wheel) ?? 'missing-wheel',
    externalCampaigns: ['python-toy', 'cross-language-hook', 'ts-toy'], oldBuiltSearch: baseline.builtSearch.integrity,
    configuredPhysicalHostCliCheck: physicalAdmission.publicCliCheck,
    oldSearchInterruptedAndResumed: true, oldSearchPersistedAcrossProcesses: true,
    legacyEnvironment: { node: process.version, npm: baseline.environment.npm,
      lockSha256: baseline.packageLock.sha256, typescript: oldTypeScript.version },
    optuna: Boolean(process.env.GEAR_ALGORITHM_OPTUNA_TEST_PYTHON) }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
